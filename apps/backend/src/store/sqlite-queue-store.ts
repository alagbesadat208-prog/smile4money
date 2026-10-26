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

/**
 * Reads the stored trace context (#123). A NULL (pre-migration row) or
 * corrupted value yields no context, so the worker starts a fresh trace
 * instead of failing the retry.
 */
function parseTraceContextColumn(raw: unknown): Pick<DlqEntry, "traceContext"> {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.traceparent === "string" ? { traceContext: parsed } : {};
  } catch {
    return {};
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

    // Open the database, then run every setup step through withRetry. The
    // steps used to sit in a nested callback that returned before this
    // retried path ran, so lock contention at startup was never retried and
    // nothing after table creation (like the #123 column migration) ran.
    await new Promise<void>((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // WAL allows readers to continue while writes are in progress.
    await withRetry<void>("initialize:walMode", (cb) =>
      this.getDb().run(`PRAGMA journal_mode=WAL`, (err: Error | null) => cb(err)),
    );

    await withRetry<void>("initialize:createTable", (cb) =>
      this.getDb().run(
        `
        CREATE TABLE IF NOT EXISTS oracle_dlq (
          id TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL,
          failureReason TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          lastAttemptAt INTEGER,
          traceContext TEXT,
          expireAt INTEGER NOT NULL,
          CONSTRAINT expireAt_check CHECK (expireAt > 0)
        )
        `,
        (err: Error | null) => cb(err),
      ),
    );

    // #123 — databases created before trace propagation lack the column.
    const columns = await withRetry<Array<{ name: string }>>("initialize:tableInfo", (cb) =>
      this.getDb().all(`PRAGMA table_info(oracle_dlq)`, (err: Error | null, rows: Array<{ name: string }>) =>
        cb(err, rows),
      ),
    );
    if (!columns.some((c) => c.name === "traceContext")) {
      await withRetry<void>("initialize:addTraceContextColumn", (cb) =>
        this.getDb().run(`ALTER TABLE oracle_dlq ADD COLUMN traceContext TEXT`, (err: Error | null) => cb(err)),
      );
    }

    await withRetry<void>("initialize:createIndex", (cb) =>
      this.getDb().run(
        `CREATE INDEX IF NOT EXISTS idx_oracle_dlq_expireAt ON oracle_dlq(expireAt)`,
        (err: Error | null) => cb(err),
      ),
    );

    this.initialized = true;
  }

  async add(entry: DlqEntry): Promise<void> {
    const expireAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
    await withRetry<void>("add", (cb) =>
      this.getDb().run(
        `
        INSERT INTO oracle_dlq (id, payload, failureReason, attempts, createdAt, lastAttemptAt, traceContext, expireAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          entry.id,
          JSON.stringify(entry.payload),
          entry.failureReason,
          entry.attempts,
          entry.createdAt,
          entry.lastAttemptAt,
          entry.traceContext ? JSON.stringify(entry.traceContext) : null,
          expireAt,
        ],
        (err: Error | null) => cb(err),
      ),
    );
  }

  async getAll(): Promise<DlqEntry[]> {
    // Delete expired entries first.
    await withRetry<void>("getAll:deleteExpired", (cb) =>
      this.getDb().run(`DELETE FROM oracle_dlq WHERE expireAt < ?`, [Date.now()], (err: Error | null) => cb(err)),
    );

    const rows = await withRetry<any[]>("getAll:select", (cb) =>
      this.getDb().all(`SELECT * FROM oracle_dlq ORDER BY createdAt ASC`, (err: Error | null, result: any[]) =>
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
      ...parseTraceContextColumn(row.traceContext),
    }));
  }

  async remove(id: string): Promise<void> {
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
