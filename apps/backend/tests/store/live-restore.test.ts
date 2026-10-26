/**
 * Restoring the queue database while the workers are running (#108).
 *
 * Uses the real SQLite store behind the maintenance gate, with concurrent
 * "worker" calls racing the restore, and checks that nothing queued since the
 * backup is lost, settled work is not replayed, a bad backup changes nothing,
 * and the workers always resume.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { SQLiteQueueStore } from '../../src/store/sqlite-queue-store.js';
import { MaintainableQueueStore } from '../../src/store/maintenance-gate.js';
import type { DlqEntry } from '../../src/store/persistent-queue-store.js';
import { performLiveRestore, validateQueueBackup } from '../../src/store/live-restore.js';

let dir: string;
let dbPath: string;
let store: MaintainableQueueStore;

function entry(id: string, matchId: number): DlqEntry {
  return {
    id,
    payload: { matchId, gameId: `g${matchId}`, winner: 'Player1' },
    failureReason: 'rpc timeout',
    attempts: 1,
    createdAt: 1_700_000_000_000 + matchId,
    lastAttemptAt: null,
  };
}

/** Copy the live database to a backup file (store must be closed or checkpointed). */
async function snapshot(name: string): Promise<string> {
  await store.close();
  const backup = path.join(dir, name);
  fs.copyFileSync(dbPath, backup);
  await store.initialize();
  return backup;
}

const ids = async () => (await store.getAll()).map((e) => e.id).sort();

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-restore-'));
  dbPath = path.join(dir, 'oracle-queue.db');
  store = new MaintainableQueueStore(new SQLiteQueueStore(dbPath));
  await store.initialize();
});

afterEach(async () => {
  await store.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('maintenance gate', () => {
  it('makes calls wait during a hold instead of failing, then runs them', async () => {
    const release = await store.hold();
    let done = false;
    const pending = store.add(entry('late', 1)).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    await pending;
    expect(await ids()).toEqual(['late']);
  });

  it('waits for in-flight calls before the hold takes effect', async () => {
    const inner = store as unknown as { inner: { getAll(): Promise<DlqEntry[]> } };
    const original = inner.inner.getAll.bind(inner.inner);
    let finish!: () => void;
    vi.spyOn(inner.inner, 'getAll').mockImplementationOnce(async () => {
      await new Promise<void>((r) => (finish = r));
      return original();
    });
    const read = store.getAll();
    let held = false;
    const holding = store.hold().then((release) => {
      held = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(held).toBe(false);
    finish();
    await read;
    (await holding)();
    expect(held).toBe(true);
  });

  it('rejects nested holds', async () => {
    const release = await store.hold();
    await expect(store.hold()).rejects.toThrow(/already held/);
    release();
  });
});

describe('performLiveRestore (#108)', () => {
  it('restores, keeps work queued since the backup, and resumes the workers', async () => {
    await store.add(entry('a', 1));
    await store.add(entry('b', 2));
    const backup = await snapshot('backup.db');

    // After the backup: one entry resolved, one new entry queued.
    await store.remove('a');
    await store.add(entry('c', 3));

    const restoring = performLiveRestore({
      store,
      backupPath: backup,
      // 'a' was resolved after the backup and its result is on-chain.
      isSettled: async (e) => (e.payload as { matchId: number }).matchId === 1,
      now: () => 42,
    });
    // A worker write issued while the restore holds the store: it waits, then
    // lands in the restored database.
    const racing = store.add(entry('d', 4));

    const report = await restoring;
    await racing;

    expect(report.readded).toEqual(['c']);
    expect(report.droppedSettled).toEqual(['a']);
    expect(report.keptUnconfirmed).toEqual([]);
    expect(fs.existsSync(`${dbPath}.pre-restore-42`)).toBe(true);
    expect(await ids()).toEqual(['b', 'c', 'd']);
    expect(store.isHeld()).toBe(false);
  });

  it('keeps restored entries it cannot confirm as settled', async () => {
    await store.add(entry('a', 1));
    const backup = await snapshot('backup.db');
    await store.remove('a');

    const report = await performLiveRestore({ store, backupPath: backup });

    expect(report.keptUnconfirmed).toEqual(['a']);
    expect(await ids()).toEqual(['a']);
  });

  it('refuses a corrupt backup, leaves the live database untouched and resumes', async () => {
    await store.add(entry('live', 1));
    const corrupt = path.join(dir, 'corrupt.db');
    fs.writeFileSync(corrupt, 'not a database'.repeat(200));

    await expect(performLiveRestore({ store, backupPath: corrupt })).rejects.toThrow(
      /failed validation/,
    );
    expect(store.isHeld()).toBe(false);
    expect(await ids()).toEqual(['live']);
  });

  it('refuses a backup without the queue schema', async () => {
    const wrong = path.join(dir, 'wrong.db');
    await new Promise<void>((resolve, reject) => {
      const db = new sqlite3.Database(wrong, (err) => {
        if (err) return reject(err);
        db.exec('CREATE TABLE oracle_dlq (id TEXT PRIMARY KEY, payload TEXT)', (e) =>
          db.close(() => (e ? reject(e) : resolve())),
        );
      });
    });

    const validation = await validateQueueBackup(wrong);
    expect(validation.ok).toBe(false);
    expect(validation.problems).toContain('oracle_dlq.failureReason is missing');
    await expect(performLiveRestore({ store, backupPath: wrong })).rejects.toThrow(
      /oracle_dlq\.attempts is missing/,
    );
  });

  it('rolls back to the pre-restore database if reconciliation fails', async () => {
    await store.add(entry('a', 1));
    const backup = await snapshot('backup.db');
    await store.remove('a');
    await store.add(entry('live', 2));

    await expect(
      performLiveRestore({
        store,
        backupPath: backup,
        isSettled: async () => {
          throw new Error('rpc down');
        },
      }),
    ).rejects.toThrow('rpc down');

    expect(store.isHeld()).toBe(false);
    expect(await ids()).toEqual(['live']);
  });
});
