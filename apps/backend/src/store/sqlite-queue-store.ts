/**
 * SQLite Persistent Queue Store
 *
 * Stores oracle job queue entries in SQLite with automatic cleanup of old entries.
 * Suitable for smaller deployments where MongoDB is not available.
 *
 * Every database call is wrapped with retry + exponential backoff (#52):
 * if another process holds the SQLite file lock (e.g. a backup script
 * running `sqlite3 .backup` or a concurrent writer), a query fails with
 * SQLITE_BUSY/SQLITE_LOCKED rather than blocking. Previously that error
 * propagated straight to the caller with the underlying SQLite error code
 * discarded, which surfaced as an opaque, unlogged crash. Now it's retried
 * a configurable number of times with the error logged before each retry,
 * and only re-thrown once retries are exhausted (or the error isn't a
 * lock-contention error to begin with).
 */

import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import type {
  DlqEntry,
  PersistentQueueStore,
} from "./persistent-queue-store.js";
import logger from "../logger.js";
import { applySqliteMigrations } from "./sqlite-migrations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** SQLite error codes that mean "another connection holds the lock right now" — worth retrying, not a real failure. */
const RETRYABLE_SQLITE_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

/** Default number of retry attempts after the initial try, before giving up. Overridable via SQLITE_MAX_RETRIES. */
const DEFAULT_MAX_RETRIES = 5;
/** Base delay for exponential backoff (doubles each attempt: 50ms, 100ms, 200ms, ...). Overridable via SQLITE_RETRY_BASE_DELAY_MS. */
const DEFAULT_BASE_DELAY_MS = 50;

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getMaxRetries(): number {
  return readPositiveInt(process.env.SQLITE_MAX_RETRIES, DEFAULT_MAX_RETRIES);
}

function getRetryBaseDelayMs(): number {
  return readPositiveInt(process.env.SQLITE_RETRY_BASE_DELAY_MS, DEFAULT_BASE_DELAY_MS);
}

export interface SqliteError extends Error {
  code?: string;
  errno?: number;
}

/** Exported for direct unit testing (#52). */
export function isRetryableSqliteError(err: unknown): err is SqliteError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as SqliteError).code === "string" &&
    RETRYABLE_SQLITE_CODES.has((err as SqliteError).code as string)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a single sqlite3 call (anything shaped like `(cb) => db.run(sql, params, cb)`)
 * with retry + exponential backoff on SQLITE_BUSY/SQLITE_LOCKED.
 *
 * `operationName` is purely for the log line, so a retried/failed operation
 * is identifiable (e.g. "add", "getAll:deleteExpired"). Exported for direct
 * unit testing (#52).
 */
export async function withRetry<T>(
  operationName: string,
  operation: (callback: (err: Error | null, result?: T) => void) => void,
): Promise<T> {
  const maxRetries = getMaxRetries();
  const baseDelayMs = getRetryBaseDelayMs();

  let attempt = 0;
  for (;;) {
    try {
      return await new Promise<T>((resolve, reject) => {
        operation((err, result) => {
          if (err) reject(err);
          else resolve(result as T);
        });
      });
    } catch (err) {
      if (!isRetryableSqliteError(err) || attempt >= maxRetries) {
        throw err;
      }

      attempt += 1;
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(
        {
          operation: operationName,
          sqlite_error_code: err.code,
          sqlite_error_message: err.message,
          attempt,
          max_retries: maxRetries,
          retry_delay_ms: delayMs,
        },
        "sqlite_operation_retrying",
      );
      await sleep(delayMs);
    }
  }
}

export class SQLiteQueueStore implements PersistentQueueStore {
  private db: sqlite3.Database | null = null;
  private dbPath: string;
  private initialized = false;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(__dirname, "../../data/oracle-queue.db");
  }

  private getDb(): sqlite3.Database {
    if (!this.db) {
      throw new Error(
        "SQLiteQueueStore not initialized. Call initialize() first.",
      );
    }
    return this.db;
  }

  async initialize(): Promise<void> {
    // Ensure the data directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await new Promise<void>((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await withRetry<void>("initialize:walMode", (cb) =>
      this.getDb().run(`PRAGMA journal_mode=WAL`, (err: Error | null) => cb(err)),
    );
    await applySqliteMigrations(this.getDb(), [
      {
        version: 1,
        name: "create-dlq",
        statements: [
          `CREATE TABLE IF NOT EXISTS oracle_dlq (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, failureReason TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, lastAttemptAt INTEGER, expireAt INTEGER NOT NULL, CONSTRAINT expireAt_check CHECK (expireAt > 0))`,
          `CREATE INDEX IF NOT EXISTS idx_oracle_dlq_expireAt ON oracle_dlq(expireAt)`,
        ],
      },
      {
        version: 2,
        name: "dlq-retention-audit",
        statements: [
          `CREATE TABLE IF NOT EXISTS oracle_dlq_audit (id TEXT PRIMARY KEY NOT NULL, createdAt INTEGER NOT NULL, archivedAt INTEGER NOT NULL, reason TEXT NOT NULL)`,
          `CREATE INDEX IF NOT EXISTS idx_oracle_dlq_audit_archivedAt ON oracle_dlq_audit(archivedAt)`,
        ],
      },
    ]);
    this.initialized = true;
  }

  private async cleanupTerminal(batchSize = 100): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (;;) {
      const rows = await withRetry<any[]>("cleanup:select", (cb) =>
        this.getDb().all(
          `SELECT id, createdAt FROM oracle_dlq WHERE expireAt < ? ORDER BY expireAt LIMIT ?`,
          [now, batchSize],
          (err: Error | null, result: any[]) => cb(err, result),
        ),
      );
      if (!rows.length) return removed;
      await withRetry<void>("cleanup:archive", (cb) =>
        this.getDb().run(
          `INSERT OR IGNORE INTO oracle_dlq_audit(id, createdAt, archivedAt, reason) SELECT id, createdAt, ?, 'retention-expired' FROM oracle_dlq WHERE id IN (${rows.map(() => "?").join(",")})`,
          [now, ...rows.map((row) => row.id)],
          (err: Error | null) => cb(err),
        ),
      );
      await withRetry<void>("cleanup:delete", (cb) =>
        this.getDb().run(
          `DELETE FROM oracle_dlq WHERE id IN (${rows.map(() => "?").join(",")})`,
          rows.map((row) => row.id),
          (err: Error | null) => cb(err),
        ),
      );
      removed += rows.length;
    }
  }

  async add(entry: DlqEntry): Promise<void> {
    const expireAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
    await withRetry<void>("add", (cb) =>
      this.getDb().run(
        `
        INSERT INTO oracle_dlq (id, payload, failureReason, attempts, createdAt, lastAttemptAt, expireAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          entry.id,
          JSON.stringify(entry.payload),
          entry.failureReason,
          entry.attempts,
          entry.createdAt,
          entry.lastAttemptAt,
          expireAt,
        ],
        (err: Error | null) => cb(err),
      ),
    );
    await this.cleanupTerminal();
    const maxEntries = readPositiveInt(process.env.DLQ_MAX_ENTRIES, 10000);
    let excess = Math.max(0, (await this.count()) - maxEntries);
    while (excess > 0) {
      const victims = await withRetry<any[]>("add:capacitySelect", (cb) =>
        this.getDb().all(
          `SELECT id, createdAt FROM oracle_dlq ORDER BY createdAt LIMIT ?`,
          [Math.min(excess, 100)],
          (err: Error | null, rows: any[]) => cb(err, rows),
        ),
      );
      if (!victims.length) throw new Error(`DLQ capacity cannot be enforced (${maxEntries} entries)`);
      const now = Date.now();
      await withRetry<void>("add:capacityArchive", (cb) =>
        this.getDb().run(
          `INSERT OR IGNORE INTO oracle_dlq_audit(id, createdAt, archivedAt, reason) SELECT id, createdAt, ?, 'capacity' FROM oracle_dlq WHERE id IN (${victims.map(() => "?").join(",")})`,
          [now, ...victims.map((row) => row.id)],
          (err: Error | null) => cb(err),
        ),
      );
      await withRetry<void>("add:capacityDelete", (cb) =>
        this.getDb().run(
          `DELETE FROM oracle_dlq WHERE id IN (${victims.map(() => "?").join(",")})`,
          victims.map((row) => row.id),
          (err: Error | null) => cb(err),
        ),
      );
      excess = Math.max(0, (await this.count()) - maxEntries);
    }
  }

  async getAll(): Promise<DlqEntry[]> {
    // Delete expired entries first.
    await this.cleanupTerminal();

    const rows = await withRetry<any[]>("getAll:select", (cb) =>
      this.getDb().all(`SELECT * FROM oracle_dlq WHERE expireAt >= ? ORDER BY createdAt ASC`, [Date.now()], (err: Error | null, result: any[]) =>
        cb(err, result),
      ),
    );

    return (rows || []).map((row) => ({
      id: row.id,
      payload: JSON.parse(row.payload),
      failureReason: row.failureReason,
      attempts: row.attempts,
      createdAt: row.createdAt,
      lastAttemptAt: row.lastAttemptAt || null,
    }));
  }

  async remove(id: string): Promise<void> {
    const now = Date.now();
    await withRetry<void>("remove:archive", (cb) =>
      this.getDb().run(
        `INSERT OR IGNORE INTO oracle_dlq_audit(id, createdAt, archivedAt, reason) SELECT id, createdAt, ?, 'resolved-or-operator-removed' FROM oracle_dlq WHERE id = ?`,
        [now, id],
        (err: Error | null) => cb(err),
      ),
    );
    await withRetry<void>("remove", (cb) =>
      this.getDb().run(`DELETE FROM oracle_dlq WHERE id = ?`, [id], (err: Error | null) => cb(err)),
    );
  }

  async update(id: string, updates: Partial<DlqEntry>): Promise<void> {
    const setClauses: string[] = [];
    const values: any[] = [];

    if (updates.attempts !== undefined) {
      setClauses.push("attempts = ?");
      values.push(updates.attempts);
    }
    if (updates.lastAttemptAt !== undefined) {
      setClauses.push("lastAttemptAt = ?");
      values.push(updates.lastAttemptAt);
    }

    if (setClauses.length === 0) {
      return;
    }

    values.push(id);

    await withRetry<void>("update", (cb) =>
      this.getDb().run(`UPDATE oracle_dlq SET ${setClauses.join(", ")} WHERE id = ?`, values, (err: Error | null) =>
        cb(err),
      ),
    );
  }

  async count(): Promise<number> {
    const row = await withRetry<any>("count", (cb) =>
      this.getDb().get(
        `SELECT COUNT(*) as count FROM oracle_dlq WHERE expireAt > ?`,
        [Date.now()],
        (err: Error | null, result: any) => cb(err, result),
      ),
    );
    return row?.count || 0;
  }

  async clear(): Promise<void> {
    await withRetry<void>("clear", (cb) =>
      this.getDb().run(`DELETE FROM oracle_dlq`, (err: Error | null) => cb(err)),
    );
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err: Error | null) => {
          if (err) reject(err);
          else {
            this.db = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}
