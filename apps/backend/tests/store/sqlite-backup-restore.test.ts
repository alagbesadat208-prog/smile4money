/**
 * Restore rehearsal for the oracle database (#104).
 *
 * Takes an online backup while the queue store is open, simulates losing the
 * database, restores, and checks that every pending settlement captured by
 * the backup survives with its payload intact. Also covers the failure
 * modes the runbook relies on: a corrupt backup is refused without touching
 * the live file, and retention keeps the newest backups.
 * See docs/oracle-db-recovery.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SQLiteQueueStore } from '../../src/store/sqlite-queue-store.js';
import { SqliteMatchStore } from '../../src/store/sqlite-match-store.js';
import type { DlqEntry } from '../../src/store/persistent-queue-store.js';
import {
  backupFileName,
  backupSqliteDatabase,
  pruneBackups,
  restoreSqliteDatabase,
  verifySqliteBackup,
} from '../../src/store/sqlite-backup.js';
import { main as cli } from '../../src/cli/db-backup.js';

let dir: string;

function settlement(id: string, matchId: number, winner: string): DlqEntry {
  return {
    id,
    payload: { matchId, gameId: `game-${matchId}`, winner },
    failureReason: 'rpc timeout',
    attempts: 2,
    createdAt: 1_700_000_000_000 + matchId,
    lastAttemptAt: 1_700_000_100_000 + matchId,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-db-recovery-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('oracle database restore rehearsal (#104)', () => {
  it('pending settlements in the backup survive a lost database', async () => {
    const dbPath = path.join(dir, 'data', 'oracle-queue.db');
    const backupPath = path.join(
      dir,
      'backups',
      backupFileName(dbPath, new Date('2026-10-22T14:00:00Z')),
    );

    const live = new SQLiteQueueStore(dbPath);
    await live.initialize();
    const pending = [
      settlement('s1', 1, 'Player1'),
      settlement('s2', 2, 'Draw'),
      settlement('s3', 3, 'Player2'),
    ];
    for (const entry of pending) await live.add(entry);

    // Online backup while the store is open and in WAL mode.
    await backupSqliteDatabase(dbPath, backupPath);

    // Written after the backup: this is the recovery-point loss.
    await live.add(settlement('s4', 4, 'Player1'));
    await live.close();

    // Lose the database entirely, including its WAL files.
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });

    const verification = await restoreSqliteDatabase(backupPath, dbPath);
    expect(verification.ok).toBe(true);
    expect(verification.tables.oracle_dlq).toBe(3);

    const restored = new SQLiteQueueStore(dbPath);
    await restored.initialize();
    const entries = await restored.getAll();
    await restored.close();

    expect(entries.map((e) => e.id).sort()).toEqual(['s1', 's2', 's3']);
    for (const original of pending) {
      const entry = entries.find((e) => e.id === original.id);
      expect(entry?.payload).toEqual(original.payload);
      expect(entry?.attempts).toBe(original.attempts);
      expect(entry?.failureReason).toBe(original.failureReason);
    }
  });

  it('match records survive a restore', async () => {
    const dbPath = path.join(dir, 'match-store.db');
    const backupPath = path.join(dir, 'match-store.backup.db');
    const live = new SqliteMatchStore(dbPath);
    await live.initialize();
    await live.createMatch({
      player1: 'GPLAYERONE',
      player2: 'GPLAYERTWO',
      stakeAmount: 10,
      token: 'xlm',
      gameId: 'abcd1234',
      platform: 'lichess',
    });
    await backupSqliteDatabase(dbPath, backupPath);
    await live.close();
    fs.rmSync(dbPath, { force: true });

    await restoreSqliteDatabase(backupPath, dbPath);
    const restored = new SqliteMatchStore(dbPath);
    await restored.initialize();
    expect(await restored.count()).toBe(1);
    expect((await restored.findByGameId('abcd1234'))?.player1).toBe('GPLAYERONE');
    await restored.close();
  });

  it('refuses a corrupt backup and leaves the live database untouched', async () => {
    const dbPath = path.join(dir, 'oracle-queue.db');
    const live = new SQLiteQueueStore(dbPath);
    await live.initialize();
    await live.add(settlement('keep', 9, 'Draw'));
    await live.close();

    const corrupt = path.join(dir, 'corrupt.db');
    fs.writeFileSync(corrupt, 'this is not a database'.repeat(100));

    expect((await verifySqliteBackup(corrupt)).ok).toBe(false);
    await expect(restoreSqliteDatabase(corrupt, dbPath)).rejects.toThrow(/unhealthy backup/);

    const reopened = new SQLiteQueueStore(dbPath);
    await reopened.initialize();
    expect((await reopened.getAll()).map((e) => e.id)).toEqual(['keep']);
    await reopened.close();
  });

  it('reports a missing backup as unhealthy', async () => {
    expect(await verifySqliteBackup(path.join(dir, 'nope.db'))).toMatchObject({ ok: false });
  });

  it('never overwrites an existing backup', async () => {
    const dbPath = path.join(dir, 'oracle-queue.db');
    const live = new SQLiteQueueStore(dbPath);
    await live.initialize();
    await live.close();
    const target = path.join(dir, 'b.db');
    await backupSqliteDatabase(dbPath, target);
    await expect(backupSqliteDatabase(dbPath, target)).rejects.toThrow(/already exists/);
  });
});

describe('backup retention (#104)', () => {
  const day = 24 * 60 * 60 * 1000;
  const db = '/var/lib/oracle/oracle-queue.db';

  function touch(at: string) {
    const name = backupFileName(db, new Date(at));
    fs.writeFileSync(path.join(dir, name), '');
    return name;
  }

  it('deletes backups past the retention window', () => {
    const now = Date.parse('2026-10-22T00:00:00Z');
    const fresh = touch('2026-10-21T00:00:00Z');
    const old = touch('2026-09-01T00:00:00Z');
    fs.writeFileSync(path.join(dir, 'unrelated.db'), '');

    expect(pruneBackups(dir, db, 35 * day, now)).toEqual([old]);
    expect(fs.readdirSync(dir).sort()).toEqual([fresh, 'unrelated.db'].sort());
  });

  it('always keeps the newest backup, however old', () => {
    const now = Date.parse('2026-10-22T00:00:00Z');
    const only = touch('2026-01-01T00:00:00Z');
    expect(pruneBackups(dir, db, 35 * day, now)).toEqual([]);
    expect(fs.existsSync(path.join(dir, only))).toBe(true);
  });

  it('names backups by database and UTC time', () => {
    expect(backupFileName(db, new Date('2026-10-22T14:05:09.123Z'))).toBe(
      'oracle-queue.2026-10-22T14-05-09Z.db',
    );
  });
});

describe('db-backup CLI (#104)', () => {
  it('backs up, verifies and restores', async () => {
    const dbPath = path.join(dir, 'oracle-queue.db');
    const backups = path.join(dir, 'backups');
    const live = new SQLiteQueueStore(dbPath);
    await live.initialize();
    await live.add(settlement('cli', 5, 'Player2'));
    await live.close();

    expect(await cli(['backup', dbPath, backups])).toBe(0);
    const [file] = fs.readdirSync(backups);
    expect(await cli(['verify', path.join(backups, file)])).toBe(0);

    fs.rmSync(dbPath, { force: true });
    expect(await cli(['restore', path.join(backups, file), dbPath])).toBe(0);
    expect((await verifySqliteBackup(dbPath)).tables.oracle_dlq).toBe(1);
  });

  it('rejects unknown commands', async () => {
    expect(await cli(['explode'])).toBe(2);
  });
});
