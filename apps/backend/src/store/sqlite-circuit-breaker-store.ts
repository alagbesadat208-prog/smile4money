import { sqliteSettings, configureSqlite } from "./sqlite-config.js";
/**
 * SQLite-backed persistence for the RPC circuit breaker (#1716).
 *
 * Before this store existed, `CircuitBreaker` (services/circuit-breaker.ts)
 * kept its state (open/closed/half-open, failure count, last failure time)
 * only in memory. Every backend restart reset it to CLOSED regardless of
 * upstream health, so if the Stellar RPC endpoint was still down when the
 * process restarted, the circuit would stay CLOSED until
 * `failureThreshold` failures accumulated again — a burst of requests
 * against a known-bad endpoint. This store lets the circuit breaker persist
 * its state on every change and reload it on startup instead.
 *
 * There is exactly one circuit breaker in this process (the global RPC
 * breaker from `getCircuitBreaker()`), so the table holds a single row,
 * keyed by a fixed id, upserted in place. Follows the same
 * retry-wrapped-sqlite3 pattern as SQLiteQueueStore.
 */

import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { withRetry } from "./sqlite-queue-store.js";
import type { CircuitState, PersistedCircuitBreakerState } from "../services/circuit-breaker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Fixed row id: this process has exactly one (global) circuit breaker. */
const ROW_ID = "rpc";

export type { PersistedCircuitBreakerState };

export class SqliteCircuitBreakerStore {
  private db: sqlite3.Database | null = null;
  private dbPath: string;
  private initialized = false;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(__dirname, "../../data/circuit-breaker.db");
  }

  private getDb(): sqlite3.Database {
    if (!this.db) {
      throw new Error(
        "SqliteCircuitBreakerStore not initialized. Call initialize() first.",
      );
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

    await configureSqlite(this.getDb());

    await withRetry<void>("circuit_breaker:initialize:walMode", (cb) =>
      this.getDb().run(`PRAGMA journal_mode=WAL`, (err: Error | null) => cb(err)),
    );

    await withRetry<void>("circuit_breaker:initialize:createTable", (cb) =>
      this.getDb().run(
        `
        CREATE TABLE IF NOT EXISTS circuit_breaker_state (
          id TEXT PRIMARY KEY NOT NULL,
          state TEXT NOT NULL,
          failureCount INTEGER NOT NULL,
          successCount INTEGER NOT NULL,
          lastFailureTime INTEGER,
          openedAt INTEGER,
          attemptCount INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        )
        `,
        (err: Error | null) => cb(err),
      ),
    );

    this.initialized = true;
  }

  /**
   * Persist the given snapshot, replacing any previously stored state for
   * the (single) circuit breaker row.
   */
  async save(snapshot: PersistedCircuitBreakerState): Promise<void> {
    await withRetry<void>("circuit_breaker:save", (cb) =>
      this.getDb().run(
        `
        INSERT INTO circuit_breaker_state
          (id, state, failureCount, successCount, lastFailureTime, openedAt, attemptCount, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state,
          failureCount = excluded.failureCount,
          successCount = excluded.successCount,
          lastFailureTime = excluded.lastFailureTime,
          openedAt = excluded.openedAt,
          attemptCount = excluded.attemptCount,
          updatedAt = excluded.updatedAt
        `,
        [
          ROW_ID,
          snapshot.state,
          snapshot.failureCount,
          snapshot.successCount,
          snapshot.lastFailureTime,
          snapshot.openedAt,
          snapshot.attemptCount,
          Date.now(),
        ],
        (err: Error | null) => cb(err),
      ),
    );
  }

  /** Returns the persisted state, or null if nothing has been saved yet. */
  async load(): Promise<PersistedCircuitBreakerState | null> {
    const row = await withRetry<any>("circuit_breaker:load", (cb) =>
      this.getDb().get(
        `SELECT * FROM circuit_breaker_state WHERE id = ?`,
        [ROW_ID],
        (err: Error | null, row: any) => cb(err, row),
      ),
    );

    if (!row) {
      return null;
    }

    return {
      state: row.state as CircuitState,
      failureCount: row.failureCount,
      successCount: row.successCount,
      lastFailureTime: row.lastFailureTime ?? null,
      openedAt: row.openedAt ?? null,
      attemptCount: row.attemptCount,
    };
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err: Error | null) => {
          if (err) reject(err);
          else {
            this.db = null;
            this.initialized = false;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}
