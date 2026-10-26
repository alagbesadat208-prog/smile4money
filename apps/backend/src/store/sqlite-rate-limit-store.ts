import { sqliteSettings, configureSqlite } from "./sqlite-config.js";
/**
 * SQLite-backed rate limiter counters (#1723).
 *
 * The in-memory `RateLimitStore` (middleware/rate-limit.ts) keeps a Map per
 * process. In a horizontally scaled deployment with multiple backend
 * instances behind a load balancer, each instance's Map is independent, so
 * the *effective* rate limit is `configured limit × instance count` instead
 * of the configured limit. This store persists the same token-bucket state
 * to a SQLite file every instance points at, so the limit holds globally.
 *
 * Concurrency: the refill-and-consume step is a single `UPDATE ... WHERE`
 * statement (see `isAllowed`) rather than a read-then-write pair, so two
 * backend instances racing to consume a token from the same bucket cannot
 * both succeed off a stale read — SQLite serializes writers against the same
 * database file, so the second UPDATE in a race always observes the first
 * one's result.
 */

import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { withRetry } from './sqlite-queue-store.js';
import type { RateLimitBackend, RateLimitResult } from '../middleware/rate-limit.js';
import { applySqliteMigrations } from './sqlite-migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class SqliteRateLimitStore implements RateLimitBackend {
  private db: sqlite3.Database | null = null;
  private dbPath: string;

  constructor(
    private capacity: number,
    private refillIntervalMs: number,
    private refillAmount: number,
    dbPath?: string,
  ) {
    this.dbPath = dbPath || path.join(__dirname, '../../data/rate-limit.db');
  }

  private getDb(): sqlite3.Database {
    if (!this.db) {
      throw new Error('SqliteRateLimitStore not initialized. Call initialize() first.');
    }
    return this.db;
  }

  async initialize(): Promise<void> {
    sqliteSettings();
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

    // WAL so readers (getRemainingTokens) never block writers (isAllowed)
    // across instances sharing this file.
    await configureSqlite(this.getDb());

    await withRetry<void>('rate_limit:initialize:walMode', (cb) =>
      this.getDb().run('PRAGMA journal_mode=WAL', (err: Error | null) => cb(err)),
    );

    await applySqliteMigrations(this.getDb(), [
      {
        version: 1,
        name: 'create-rate-limit-buckets',
        statements: [
          `CREATE TABLE IF NOT EXISTS rate_limit_buckets (clientId TEXT PRIMARY KEY NOT NULL, tokens REAL NOT NULL, lastRefill INTEGER NOT NULL)`,
        ],
      },
      {
        version: 2,
        name: 'rate-limit-refill-index',
        statements: [`CREATE INDEX IF NOT EXISTS idx_rate_limit_last_refill ON rate_limit_buckets(lastRefill)`],
      },
    ]);
  }

  /**
   * Atomically refill-then-consume a token for `clientId`.
   *
   * The UPDATE's SET clause recomputes the refilled token count inline
   * (capped at `capacity`) and immediately subtracts the one token this call
   * consumes; the WHERE clause requires that refilled count to be at least 1
   * *before* consuming it is possible at all. Because this is a single SQL
   * statement, SQLite's own write-locking makes the whole
   * refill-check-consume sequence atomic with respect to any other
   * connection — including another backend instance's connection to the
   * same file — eliminating the read-then-write race a SELECT followed by
   * an UPDATE would have.
   */
  async isAllowed(clientId: string): Promise<RateLimitResult> {
    const now = Date.now();

    // Ensure a row exists before the UPDATE below; a brand new client starts
    // at capacity - 1 (one token consumed by this very request), matching
    // the in-memory store's first-request behavior.
    const inserted = await withRetry<number>('rate_limit:isAllowed:insertNew', (cb) =>
      this.getDb().run(
        `INSERT INTO rate_limit_buckets (clientId, tokens, lastRefill)
         VALUES (?, ?, ?)
         ON CONFLICT(clientId) DO NOTHING`,
        [clientId, this.capacity - 1, now],
        function (this: sqlite3.RunResult, err: Error | null) {
          if (err) cb(err);
          else cb(null, this.changes);
        },
      ),
    );
    if (inserted > 0) {
      return { allowed: true };
    }

    // Continuous (fractional) refill rather than the in-memory store's
    // discrete-interval refill: every call recomputes tokens from elapsed
    // time since `lastRefill` and immediately stamps `lastRefill = now`, so
    // there is no separate "did a whole interval pass?" branch to get out of
    // sync with what was just written.
    const refillExpr = `MIN(${this.capacity}, tokens + (CAST((? - lastRefill) AS REAL) / ${this.refillIntervalMs}) * ${this.refillAmount})`;
    const result = await withRetry<{ changes: number }>('rate_limit:isAllowed:consume', (cb) =>
      this.getDb().run(
        `UPDATE rate_limit_buckets
         SET tokens = ${refillExpr} - 1,
             lastRefill = ?
         WHERE clientId = ? AND ${refillExpr} >= 1`,
        [now, now, clientId, now],
        function (this: sqlite3.RunResult, err: Error | null) {
          if (err) cb(err);
          else cb(null, { changes: this.changes });
        },
      ),
    );

    if (result.changes > 0) {
      return { allowed: true };
    }

    // Rate limited. Read back the bucket to compute a Retry-After.
    const row = await withRetry<{ tokens: number; lastRefill: number } | undefined>(
      'rate_limit:isAllowed:readForRetryAfter',
      (cb) =>
        this.getDb().get(
          'SELECT tokens, lastRefill FROM rate_limit_buckets WHERE clientId = ?',
          [clientId],
          (err: Error | null, row: any) => cb(err, row),
        ),
    );

    const lastRefill = row?.lastRefill ?? now;
    const timeUntilNextRefillMs = this.refillIntervalMs - (now - lastRefill);
    const retryAfterSeconds = Math.max(1, Math.ceil(timeUntilNextRefillMs / 1000));

    return { allowed: false, retryAfterSeconds };
  }

  async getRemainingTokens(clientId: string): Promise<number> {
    const row = await withRetry<{ tokens: number; lastRefill: number } | undefined>(
      'rate_limit:getRemainingTokens',
      (cb) =>
        this.getDb().get(
          'SELECT tokens, lastRefill FROM rate_limit_buckets WHERE clientId = ?',
          [clientId],
          (err: Error | null, row: any) => cb(err, row),
        ),
    );

    if (!row) {
      return this.capacity;
    }

    const now = Date.now();
    const refilled = row.tokens + ((now - row.lastRefill) / this.refillIntervalMs) * this.refillAmount;
    return Math.min(this.capacity, Math.max(0, refilled));
  }

  async destroy(): Promise<void> {
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
