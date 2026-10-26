/**
 * Maintenance gate for the oracle queue store (#108).
 *
 * Wraps the queue store so a live database restore can quiesce every reader
 * and writer without stopping the process: `hold()` stops new store calls
 * from starting (they wait, they do not fail) and resolves once the calls
 * already running have finished. While held, the underlying database can be
 * closed, replaced and reopened. `release()` lets the waiting calls run,
 * against the restored database.
 *
 * Nothing is lost while held. The polling worker's dead-letter writes and the
 * retry worker's reads and updates simply wait. Nothing errors because the
 * store is closed mid-call, so the retry worker never sees a half-open
 * database.
 */
import type { DlqEntry, PersistentQueueStore } from './persistent-queue-store.js';

export class MaintainableQueueStore implements PersistentQueueStore {
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;
  private inFlight = 0;
  private drained: (() => void) | null = null;

  constructor(private readonly inner: PersistentQueueStore) {}

  /** The SQLite file behind the store, or null for a non-file store. */
  databasePath(): string | null {
    const candidate = (this.inner as unknown as { dbPath?: unknown }).dbPath;
    return typeof candidate === 'string' ? candidate : null;
  }

  /** True while a maintenance hold is active. */
  isHeld(): boolean {
    return this.gate !== null;
  }

  /**
   * Stop new store calls and wait for running ones to finish. Returns the
   * function that lifts the hold. Holds do not nest.
   */
  async hold(): Promise<() => void> {
    if (this.gate) throw new Error('queue store is already held for maintenance');
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
    if (this.inFlight > 0) {
      await new Promise<void>((resolve) => {
        this.drained = resolve;
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const open = this.openGate;
      this.gate = null;
      this.openGate = null;
      open?.();
    };
  }

  /** Close and reopen the underlying store, e.g. after its file was replaced. Only while held. */
  async reopen(): Promise<void> {
    if (!this.gate) throw new Error('reopen() requires a maintenance hold');
    await this.inner.close();
    await this.inner.initialize();
  }

  /** Direct access to the underlying store while held (the gate would block it). */
  unsafeInner(): PersistentQueueStore {
    if (!this.gate) throw new Error('unsafeInner() requires a maintenance hold');
    return this.inner;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    while (this.gate) await this.gate;
    this.inFlight += 1;
    try {
      return await operation();
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0 && this.drained) {
        const done = this.drained;
        this.drained = null;
        done();
      }
    }
  }

  initialize(): Promise<void> {
    return this.inner.initialize();
  }

  add(entry: DlqEntry): Promise<void> {
    return this.run(() => this.inner.add(entry));
  }

  getAll(): Promise<DlqEntry[]> {
    return this.run(() => this.inner.getAll());
  }

  remove(id: string): Promise<void> {
    return this.run(() => this.inner.remove(id));
  }

  update(id: string, updates: Partial<DlqEntry>): Promise<void> {
    return this.run(() => this.inner.update(id, updates));
  }

  count(): Promise<number> {
    return this.run(() => this.inner.count());
  }

  clear(): Promise<void> {
    return this.run(() => this.inner.clear());
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
