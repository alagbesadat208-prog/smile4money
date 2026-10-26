/**
 * Capacity limits and disk-pressure alarms for persistent storage (#105).
 *
 * The oracle's SQLite files (queue, match records, rate-limit and
 * circuit-breaker state) share one runtime volume. Running it out of space
 * stops settlement processing. This module:
 *
 * - measures each database, including its `-wal`/`-shm` files;
 * - measures free space on the volume holding them;
 * - compares both against a configured budget and raises a warning or a
 *   critical alarm before the volume is exhausted;
 * - offers `reclaimSpace`, which compacts a database (WAL checkpoint and
 *   VACUUM) and never deletes a row. Pending settlements are never cleaned
 *   up to make room.
 *
 * Configuration (see docs/storage-capacity.md):
 *   STORAGE_CAPACITY_BYTES      budget for all databases together (default 1 GiB)
 *   STORAGE_WARN_RATIO          warn at this share of the budget (default 0.8)
 *   STORAGE_CRITICAL_RATIO      critical at this share (default 0.95)
 *   STORAGE_MIN_FREE_BYTES      critical when the volume has less free (default 512 MiB)
 *   STORAGE_CHECK_INTERVAL_MS   how often the monitor runs (default 5 min)
 */
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';

const MIB = 1024 * 1024;

export interface CapacityConfig {
  capacityBytes: number;
  warnRatio: number;
  criticalRatio: number;
  minFreeBytes: number;
  intervalMs: number;
}

export const DEFAULT_CAPACITY_CONFIG: CapacityConfig = {
  capacityBytes: 1024 * MIB,
  warnRatio: 0.8,
  criticalRatio: 0.95,
  minFreeBytes: 512 * MIB,
  intervalMs: 5 * 60 * 1000,
};

export type CapacityLevel = 'ok' | 'warning' | 'critical';

export interface DatabaseUsage {
  path: string;
  bytes: number;
}

export interface StorageReport {
  level: CapacityLevel;
  databases: DatabaseUsage[];
  totalBytes: number;
  capacityBytes: number;
  usedRatio: number;
  volumeFreeBytes: number | null;
  reasons: string[];
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function ratio(raw: string | undefined, fallback: number): number {
  const value = positive(raw, fallback);
  return value < 1 ? value : fallback;
}

/** Capacity configuration from the environment; invalid values fall back to defaults. */
export function parseCapacityConfig(env: NodeJS.ProcessEnv = process.env): CapacityConfig {
  const d = DEFAULT_CAPACITY_CONFIG;
  const warnRatio = ratio(env.STORAGE_WARN_RATIO, d.warnRatio);
  let criticalRatio = ratio(env.STORAGE_CRITICAL_RATIO, d.criticalRatio);
  if (criticalRatio <= warnRatio) criticalRatio = Math.max(warnRatio, d.criticalRatio);
  return {
    capacityBytes: positive(env.STORAGE_CAPACITY_BYTES, d.capacityBytes),
    warnRatio,
    criticalRatio,
    minFreeBytes: positive(env.STORAGE_MIN_FREE_BYTES, d.minFreeBytes),
    intervalMs: positive(env.STORAGE_CHECK_INTERVAL_MS, d.intervalMs),
  };
}

/** Bytes used by a SQLite database: the main file plus its WAL and shared memory. */
export function databaseBytes(dbPath: string): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(`${dbPath}${suffix}`).size;
    } catch {
      // Missing companion files are normal.
    }
  }
  return total;
}

/** Free bytes on the volume holding `target`, or null when it can't be read. */
export function volumeFreeBytes(target: string): number | null {
  try {
    const stats = fs.statfsSync(fs.existsSync(target) ? target : path.dirname(target));
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** Measure the databases and classify the result against `config`. */
export function checkStorage(
  databasePaths: string[],
  config: CapacityConfig = parseCapacityConfig(),
  freeBytes: (target: string) => number | null = volumeFreeBytes,
): StorageReport {
  const databases = databasePaths.map((p) => ({ path: p, bytes: databaseBytes(p) }));
  const totalBytes = databases.reduce((sum, d) => sum + d.bytes, 0);
  const usedRatio = totalBytes / config.capacityBytes;
  const volumeFree = databasePaths.length > 0 ? freeBytes(databasePaths[0]) : null;

  const reasons: string[] = [];
  let level: CapacityLevel = 'ok';
  const raise = (to: CapacityLevel, reason: string) => {
    reasons.push(reason);
    if (to === 'critical' || level === 'ok') level = to;
  };

  if (usedRatio >= config.criticalRatio) {
    raise(
      'critical',
      `databases use ${(usedRatio * 100).toFixed(1)}% of the ${config.capacityBytes}-byte budget`,
    );
  } else if (usedRatio >= config.warnRatio) {
    raise(
      'warning',
      `databases use ${(usedRatio * 100).toFixed(1)}% of the ${config.capacityBytes}-byte budget`,
    );
  }
  if (volumeFree !== null && volumeFree < config.minFreeBytes) {
    raise(
      'critical',
      `volume has ${volumeFree} bytes free, below the ${config.minFreeBytes}-byte minimum`,
    );
  }

  return {
    level,
    databases,
    totalBytes,
    capacityBytes: config.capacityBytes,
    usedRatio,
    volumeFreeBytes: volumeFree,
    reasons,
  };
}

export interface CapacityLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Check storage on an interval and log `storage_capacity` every run (a
 * metric) plus an alarm line on warning (`storage_capacity_warning`) and
 * critical (`storage_capacity_critical`). Returns a stop function. The timer
 * does not keep the process alive.
 */
export function startStorageCapacityMonitor(
  databasePaths: string[],
  logger: CapacityLogger,
  config: CapacityConfig = parseCapacityConfig(),
): () => void {
  const run = () => {
    const report = checkStorage(databasePaths, config);
    const fields = {
      metric: 'storage_capacity',
      level: report.level,
      total_bytes: report.totalBytes,
      capacity_bytes: report.capacityBytes,
      used_ratio: Number(report.usedRatio.toFixed(4)),
      volume_free_bytes: report.volumeFreeBytes,
      reasons: report.reasons,
    };
    logger.info(fields, 'storage_capacity');
    if (report.level === 'critical') logger.error(fields, 'storage_capacity_critical');
    else if (report.level === 'warning') logger.warn(fields, 'storage_capacity_warning');
  };
  run();
  const timer = setInterval(run, config.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Compact a database to give space back: checkpoint and truncate the WAL,
 * then VACUUM. Rows are never deleted, so pending settlements survive. Run in
 * a quiet period: VACUUM briefly needs up to the database's size in free space.
 * Returns bytes before and after.
 */
export async function reclaimSpace(dbPath: string): Promise<{ before: number; after: number }> {
  const before = databaseBytes(dbPath);
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const handle = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) =>
      err ? reject(err) : resolve(handle),
    );
  });
  const exec = (sql: string) =>
    new Promise<void>((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve())));
  try {
    await exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await exec('VACUUM');
    await exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    await new Promise<void>((resolve) => db.close(() => resolve()));
  }
  return { before, after: databaseBytes(dbPath) };
}
