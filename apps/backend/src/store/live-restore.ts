/**
 * Restore the oracle queue database while the workers are running (#108).
 *
 * Replacing the SQLite file under a live retry worker or polling worker can
 * replay settlements that were already submitted, or lose ones queued since
 * the backup. `performLiveRestore` makes it safe:
 *
 * 1. **Quiesce**: hold the queue store (see maintenance-gate.ts). New reads
 *    and writes wait; running ones finish first. The workers keep running
 *    but cannot touch the database.
 * 2. **Snapshot**: record the live entries, so nothing queued since the
 *    backup is lost.
 * 3. **Validate**: the backup must pass `PRAGMA integrity_check` and have
 *    the `oracle_dlq` table with every column the store uses. Otherwise
 *    abort with the live database untouched.
 * 4. **Swap**: keep the live file as `<db>.pre-restore-<time>`, copy the
 *    backup into place atomically, clear stale `-wal`/`-shm`, reopen.
 * 5. **Reconcile**:
 *    - re-add live entries missing from the backup (queued after it);
 *    - drop restored entries that are no longer live, if `isSettled` confirms
 *      the result is on-chain (resolved after the backup, so no replay);
 *    - keep every other restored entry.
 * 6. **Resume**: lift the hold; waiting calls run against the restored data.
 *
 * Any failure after the swap rolls back to the pre-restore file before
 * resuming. The workers are never left held.
 */
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import type { DlqEntry } from './persistent-queue-store.js';
import type { MaintainableQueueStore } from './maintenance-gate.js';

/** Columns the SQLite queue store reads and writes. */
export const REQUIRED_DLQ_COLUMNS = [
  'id',
  'payload',
  'failureReason',
  'attempts',
  'createdAt',
  'lastAttemptAt',
  'expireAt',
] as const;

export interface SchemaValidation {
  ok: boolean;
  problems: string[];
  rows: number;
}

export interface LiveRestoreOptions {
  store: MaintainableQueueStore;
  backupPath: string;
  /** The live database file; defaults to the store's own path. */
  databasePath?: string;
  /**
   * Whether a restored entry's result is already on-chain. Entries that are
   * in the backup but no longer live are dropped only when this says so;
   * otherwise they are kept, and idempotent submission skips them later.
   */
  isSettled?: (entry: DlqEntry) => Promise<boolean>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

export interface LiveRestoreReport {
  databasePath: string;
  preRestoreCopy: string;
  restoredEntries: number;
  /** Live entries absent from the backup, added back. */
  readded: string[];
  /** Restored entries already settled on-chain, removed. */
  droppedSettled: string[];
  /** Restored entries not live before the restore, kept as pending. */
  keptUnconfirmed: string[];
}

function all<T>(db: sqlite3.Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) =>
    db.all(sql, (err: Error | null, rows: T[]) => (err ? reject(err) : resolve(rows))),
  );
}

/** Check a backup file is a healthy queue database the store can use. */
export async function validateQueueBackup(file: string): Promise<SchemaValidation> {
  if (!fs.existsSync(file)) return { ok: false, problems: ['backup file not found'], rows: 0 };
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const handle = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (err) =>
      err ? reject(err) : resolve(handle),
    );
  }).catch((err: Error) => err);
  if (db instanceof Error) return { ok: false, problems: [db.message], rows: 0 };

  const problems: string[] = [];
  let rows = 0;
  try {
    const integrity = (await all<{ integrity_check: string }>(db, 'PRAGMA integrity_check')).map(
      (r) => r.integrity_check,
    );
    if (integrity.length !== 1 || integrity[0] !== 'ok')
      problems.push(`integrity_check: ${integrity.join('; ')}`);
    const columns = new Set(
      (await all<{ name: string }>(db, 'PRAGMA table_info(oracle_dlq)')).map((c) => c.name),
    );
    if (columns.size === 0) problems.push('table oracle_dlq is missing');
    else {
      for (const column of REQUIRED_DLQ_COLUMNS) {
        if (!columns.has(column)) problems.push(`oracle_dlq.${column} is missing`);
      }
      if (problems.length === 0) {
        rows = (await all<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM oracle_dlq'))[0].n;
      }
    }
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  } finally {
    await new Promise<void>((resolve) => db.close(() => resolve()));
  }
  return { ok: problems.length === 0, problems, rows };
}

function swapIn(source: string, target: string): void {
  const staging = `${target}.restoring`;
  fs.copyFileSync(source, staging);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
  fs.renameSync(staging, target);
}

/** Restore the queue database from `backupPath` without stopping the service. */
export async function performLiveRestore(options: LiveRestoreOptions): Promise<LiveRestoreReport> {
  const { store, backupPath } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const isSettled = options.isSettled ?? (async () => false);
  const databasePath = options.databasePath ?? store.databasePath();
  if (!databasePath) throw new Error('live restore needs a file-backed queue store');

  const release = await store.hold();
  log('live_restore_quiesced', { databasePath });
  try {
    const inner = store.unsafeInner();
    const live = await inner.getAll();
    log('live_restore_snapshot', { liveEntries: live.length });

    const validation = await validateQueueBackup(backupPath);
    if (!validation.ok) {
      log('live_restore_rejected', { problems: validation.problems });
      throw new Error(`backup failed validation: ${validation.problems.join('; ')}`);
    }

    // Copy the live database aside for rollback. A checkpoint first would need
    // a write; closing the store flushes the WAL into the main file instead.
    await inner.close();
    const preRestoreCopy = `${databasePath}.pre-restore-${now()}`;
    if (fs.existsSync(databasePath)) fs.copyFileSync(databasePath, preRestoreCopy);

    try {
      swapIn(backupPath, databasePath);
      await inner.initialize();
      log('live_restore_swapped', { backupRows: validation.rows, preRestoreCopy });

      const restored = await inner.getAll();
      const restoredIds = new Set(restored.map((e) => e.id));
      const liveIds = new Set(live.map((e) => e.id));

      const readded: string[] = [];
      for (const entry of live) {
        if (!restoredIds.has(entry.id)) {
          await inner.add(entry);
          readded.push(entry.id);
        }
      }

      const droppedSettled: string[] = [];
      const keptUnconfirmed: string[] = [];
      for (const entry of restored) {
        if (liveIds.has(entry.id)) continue;
        if (await isSettled(entry)) {
          await inner.remove(entry.id);
          droppedSettled.push(entry.id);
        } else {
          keptUnconfirmed.push(entry.id);
        }
      }

      const report: LiveRestoreReport = {
        databasePath,
        preRestoreCopy,
        restoredEntries: restored.length,
        readded,
        droppedSettled,
        keptUnconfirmed,
      };
      log('live_restore_reconciled', { ...report });
      return report;
    } catch (err) {
      log('live_restore_rolling_back', { error: err instanceof Error ? err.message : String(err) });
      await inner.close().catch(() => {});
      if (fs.existsSync(preRestoreCopy)) swapIn(preRestoreCopy, databasePath);
      await inner.initialize();
      throw err;
    }
  } finally {
    release();
    log('live_restore_resumed');
  }
}

/** Request file the maintenance signal handler reads (see maintenance.ts). */
export function defaultRestoreRequestPath(databasePath: string): string {
  return path.join(path.dirname(databasePath), 'restore-request.json');
}
