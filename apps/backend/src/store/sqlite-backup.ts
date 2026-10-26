/**
 * Backup, verification and restore for the oracle's SQLite databases (#104).
 *
 * The oracle keeps its durable state in SQLite files: pending result
 * submissions in `oracle-queue.db` (table `oracle_dlq`) and match records in
 * `match-store.db`. Recovery objectives, schedule and the restore procedure
 * are in docs/oracle-db-recovery.md; this module is what that procedure runs,
 * and `tests/store/sqlite-backup-restore.test.ts` rehearses it.
 *
 * - `backupSqliteDatabase` takes a consistent online snapshot with
 *   `VACUUM INTO`, which is safe while the service is writing (WAL mode) and
 *   produces a single self-contained file with no `-wal`/`-shm` companions.
 * - `verifySqliteBackup` runs `PRAGMA integrity_check` and counts rows per
 *   table, so a backup is known to be usable before it is needed.
 * - `restoreSqliteDatabase` verifies first, then swaps the file into place
 *   atomically. A corrupt backup never replaces a working database.
 * - `pruneBackups` enforces the retention window.
 */
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';

export interface BackupVerification {
  ok: boolean;
  /** `PRAGMA integrity_check` output; `['ok']` for a healthy file. */
  integrity: string[];
  /** Row count per user table. */
  tables: Record<string, number>;
}

function open(file: string, mode: number): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, mode, (err) => (err ? reject(err) : resolve(db)));
  });
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

function all<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err: Error | null, rows: T[]) => (err ? reject(err) : resolve(rows))),
  );
}

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) =>
    db.run(sql, params, (err: Error | null) => (err ? reject(err) : resolve())),
  );
}

/**
 * Write a consistent snapshot of `sourcePath` to `backupPath`. Safe to run
 * against a live database. Refuses to overwrite an existing file.
 */
export async function backupSqliteDatabase(sourcePath: string, backupPath: string): Promise<void> {
  if (!fs.existsSync(sourcePath)) throw new Error(`database not found: ${sourcePath}`);
  if (fs.existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });

  // Read-write only so a WAL database without a `-shm` file can be opened;
  // VACUUM INTO never modifies the source.
  const db = await open(sourcePath, sqlite3.OPEN_READWRITE);
  try {
    await run(db, 'VACUUM INTO ?', [backupPath]);
  } finally {
    await close(db);
  }
}

/** Check a backup file is a healthy SQLite database and count its rows. */
export async function verifySqliteBackup(file: string): Promise<BackupVerification> {
  if (!fs.existsSync(file)) return { ok: false, integrity: ['file not found'], tables: {} };
  let db: sqlite3.Database;
  try {
    // Read-write for the same WAL reason as backupSqliteDatabase; nothing is written.
    db = await open(file, sqlite3.OPEN_READWRITE);
  } catch (err) {
    return { ok: false, integrity: [err instanceof Error ? err.message : String(err)], tables: {} };
  }
  try {
    const integrity = (await all<{ integrity_check: string }>(db, 'PRAGMA integrity_check')).map(
      (row) => row.integrity_check,
    );
    const names = await all<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const tables: Record<string, number> = {};
    for (const { name } of names) {
      const [row] = await all<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`,
      );
      tables[name] = row.n;
    }
    return { ok: integrity.length === 1 && integrity[0] === 'ok', integrity, tables };
  } catch (err) {
    return { ok: false, integrity: [err instanceof Error ? err.message : String(err)], tables: {} };
  } finally {
    await close(db).catch(() => {});
  }
}

/**
 * Replace `targetPath` with `backupPath`. The service using the database
 * must be stopped first. The backup is verified before anything is touched,
 * copied next to the target and renamed over it, and the target's stale
 * `-wal`/`-shm` files are removed so SQLite cannot replay them onto the
 * restored data.
 */
export async function restoreSqliteDatabase(
  backupPath: string,
  targetPath: string,
): Promise<BackupVerification> {
  const verification = await verifySqliteBackup(backupPath);
  if (!verification.ok) {
    throw new Error(
      `refusing to restore an unhealthy backup (${verification.integrity.join('; ')})`,
    );
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const staging = `${targetPath}.restoring`;
  fs.copyFileSync(backupPath, staging);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${targetPath}${suffix}`, { force: true });
  fs.renameSync(staging, targetPath);
  return verification;
}

/** File name for a backup taken at `at`, e.g. `oracle-queue.2026-10-22T14-00-00Z.db`. */
export function backupFileName(databasePath: string, at: Date = new Date()): string {
  const base = path.basename(databasePath, path.extname(databasePath));
  const stamp = at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
  return `${base}.${stamp}.db`;
}

/**
 * Delete backups of `databasePath` in `dir` older than `retentionMs`,
 * always keeping the newest `keepAtLeast` regardless of age. Returns the
 * deleted file names.
 */
export function pruneBackups(
  dir: string,
  databasePath: string,
  retentionMs: number,
  now: number = Date.now(),
  keepAtLeast = 1,
): string[] {
  if (!fs.existsSync(dir)) return [];
  const base = path.basename(databasePath, path.extname(databasePath));
  const pattern = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z)\\.db$`,
  );
  const backups = fs
    .readdirSync(dir)
    .map((name) => {
      const match = pattern.exec(name);
      if (!match) return null;
      const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z');
      return { name, at: Date.parse(iso) };
    })
    .filter((b): b is { name: string; at: number } => b !== null && Number.isFinite(b.at))
    .sort((a, b) => b.at - a.at);

  const deleted: string[] = [];
  backups.forEach((backup, index) => {
    if (index < keepAtLeast || now - backup.at <= retentionMs) return;
    fs.rmSync(path.join(dir, backup.name), { force: true });
    deleted.push(backup.name);
  });
  return deleted;
}
