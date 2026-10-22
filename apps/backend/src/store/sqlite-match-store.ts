/**
 * SQLite-backed MatchStore
 *
 * Persists match records to a local SQLite database so they survive
 * process restarts. Follows the same pattern as SQLiteQueueStore.
 */

import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { MatchRecord } from './match-store.js';
import { computeIdentityHash } from '../services/player-identity.js';
import { applySqliteMigrations } from './sqlite-migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface CreateMatchPayload {
  player1: string;
  player2: string;
  player1Username?: string;
  player2Username?: string;
  stakeAmount: number;
  token: string;
  gameId: string;
  platform: string;
}

export class SqliteMatchStore {
  private db: sqlite3.Database | null = null;
  private dbPath: string;
  private nextId = 0;
  private initialized = false;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(__dirname, '../../data/match-store.db');
  }

  private getDb(): sqlite3.Database {
    if (!this.db) {
      throw new Error('SqliteMatchStore not initialized. Call initialize() first.');
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
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
    await new Promise<void>((resolve, reject) =>
      this.getDb().run('PRAGMA journal_mode=WAL', (error) => (error ? reject(error) : resolve())),
    );
    await applySqliteMigrations(this.getDb(), [
      {
        version: 1,
        name: 'create-matches',
        statements: [
          `CREATE TABLE IF NOT EXISTS matches (matchId INTEGER PRIMARY KEY AUTOINCREMENT, player1 TEXT NOT NULL, player2 TEXT NOT NULL, player1Username TEXT, player2Username TEXT, stakeAmount REAL NOT NULL, token TEXT NOT NULL, gameId TEXT NOT NULL UNIQUE, platform TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'Pending', identityHash TEXT)`,
        ],
      },
      {
        version: 2,
        name: 'settlement-outbox-and-jobs',
        statements: [
          `CREATE TABLE IF NOT EXISTS settlement_jobs (id TEXT PRIMARY KEY NOT NULL, matchId INTEGER NOT NULL UNIQUE REFERENCES matches(matchId), gameId TEXT NOT NULL, platform TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','completed','failed','superseded')), createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
          `CREATE TABLE IF NOT EXISTS settlement_outbox (id TEXT PRIMARY KEY NOT NULL, eventType TEXT NOT NULL, aggregateId TEXT NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL, dispatchedAt INTEGER, attempts INTEGER NOT NULL DEFAULT 0)`,
          `CREATE INDEX IF NOT EXISTS idx_settlement_outbox_pending ON settlement_outbox(dispatchedAt, createdAt)`,
          `CREATE INDEX IF NOT EXISTS idx_settlement_jobs_state ON settlement_jobs(state, updatedAt)`,
        ],
      },
      {
        version: 3,
        name: 'terminal-work-audit',
        statements: [
          `CREATE TABLE IF NOT EXISTS settlement_work_audit (recordId TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, archivedAt INTEGER NOT NULL, reason TEXT NOT NULL)`,
          `CREATE INDEX IF NOT EXISTS idx_settlement_work_audit_archivedAt ON settlement_work_audit(archivedAt)`,
        ],
      },
    ]);
    const row = await new Promise<any>((resolve, reject) =>
      this.getDb().get('SELECT COALESCE(MAX(matchId), -1) + 1 AS nextId FROM matches', (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
    this.nextId = row?.nextId ?? 0;
    this.initialized = true;
  }

  async createMatch(payload: CreateMatchPayload): Promise<MatchRecord> {
    // #1720 — see match-store.ts's MatchStore.createMatch for the rationale;
    // kept identical here so both store implementations bind the same way.
    const identityHash =
      payload.player1Username && payload.player2Username
        ? computeIdentityHash(payload.player1Username, payload.player1, payload.player2Username, payload.player2)
        : null;

    const matchId = this.nextId;
    const now = Date.now();
    const jobId = `settlement:${payload.gameId}`;
    const jobPayload = JSON.stringify({ matchId, ...payload });
    const outboxPayload = JSON.stringify({
      id: jobId,
      matchId,
      gameId: payload.gameId,
      platform: payload.platform,
      username: payload.player1Username,
    });
    const run = (sql: string, params: unknown[] = []) =>
      new Promise<void>((resolve, reject) =>
        this.getDb().run(sql, params, (error) => (error ? reject(error) : resolve())),
      );
    try {
      await run('BEGIN IMMEDIATE');
      await run(
        `INSERT INTO matches (matchId, player1, player2, player1Username, player2Username, stakeAmount, token, gameId, platform, state, identityHash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`,
        [
          matchId,
          payload.player1,
          payload.player2,
          payload.player1Username ?? null,
          payload.player2Username ?? null,
          payload.stakeAmount,
          payload.token,
          payload.gameId,
          payload.platform,
          identityHash,
        ],
      );
      await run(
        `INSERT INTO settlement_jobs(id, matchId, gameId, platform, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [jobId, matchId, payload.gameId, payload.platform, jobPayload, now, now],
      );
      await run(
        `INSERT INTO settlement_outbox(id, eventType, aggregateId, payload, createdAt) VALUES (?, 'settlement.requested', ?, ?, ?)`,
        [jobId, String(matchId), outboxPayload, now],
      );
      await run('COMMIT');
      this.nextId += 1;
      return {
        matchId,
        player1: payload.player1,
        player2: payload.player2,
        player1Username: payload.player1Username,
        player2Username: payload.player2Username,
        stakeAmount: payload.stakeAmount,
        token: payload.token,
        gameId: payload.gameId,
        platform: payload.platform,
        state: 'Pending',
        identityHash: identityHash ?? undefined,
      };
    } catch (error) {
      await run('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  /** Deliver pending events at least once. Consumers should use event.id as
   * their idempotency key; marking dispatched only follows successful delivery. */
  async dispatchOutbox(
    deliver: (event: { id: string; type: string; aggregateId: string; payload: unknown }) => Promise<void>,
    batchSize = 100,
  ): Promise<number> {
    const rows = await new Promise<any[]>((resolve, reject) =>
      this.getDb().all(
        `SELECT * FROM settlement_outbox WHERE dispatchedAt IS NULL ORDER BY createdAt LIMIT ?`,
        [batchSize],
        (error, result) => (error ? reject(error) : resolve(result)),
      ),
    );
    let delivered = 0;
    for (const row of rows) {
      try {
        await deliver({
          id: row.id,
          type: row.eventType,
          aggregateId: row.aggregateId,
          payload: JSON.parse(row.payload),
        });
        await new Promise<void>((resolve, reject) =>
          this.getDb().run(
            `UPDATE settlement_outbox SET dispatchedAt = ?, attempts = attempts + 1 WHERE id = ? AND dispatchedAt IS NULL`,
            [Date.now(), row.id],
            (error) => (error ? reject(error) : resolve()),
          ),
        );
        delivered += 1;
      } catch (error) {
        await new Promise<void>((resolve) =>
          this.getDb().run(`UPDATE settlement_outbox SET attempts = attempts + 1 WHERE id = ?`, [row.id], () =>
            resolve(),
          ),
        );
        throw error;
      }
    }
    return delivered;
  }

  /** Batch archive aged terminal jobs and delivered events, preserving their
   * stable IDs for audit references. Pending/processing work is never pruned. */
  async cleanupTerminalWork(now = Date.now(), batchSize = 100): Promise<number> {
    const jobDays = Number(process.env.SETTLEMENT_TERMINAL_RETENTION_DAYS ?? 90);
    const eventDays = Number(process.env.OUTBOX_DELIVERED_RETENTION_DAYS ?? 30);
    if (!Number.isFinite(jobDays) || jobDays <= 0 || !Number.isFinite(eventDays) || eventDays <= 0)
      throw new Error('Settlement retention values must be positive day counts');
    const candidates = await new Promise<any[]>((resolve, reject) =>
      this.getDb().all(
        `SELECT id, kind FROM (SELECT id, 'job' AS kind, updatedAt AS timestamp FROM settlement_jobs WHERE state IN ('completed','failed','superseded') AND updatedAt < ? UNION ALL SELECT id, 'outbox' AS kind, dispatchedAt AS timestamp FROM settlement_outbox WHERE dispatchedAt IS NOT NULL AND dispatchedAt < ?) ORDER BY timestamp LIMIT ?`,
        [now - jobDays * 86400000, now - eventDays * 86400000, batchSize],
        (error, rows) => (error ? reject(error) : resolve(rows)),
      ),
    );
    for (const row of candidates) {
      await new Promise<void>((resolve, reject) =>
        this.getDb().run(
          `INSERT OR IGNORE INTO settlement_work_audit(recordId, kind, archivedAt, reason) VALUES (?, ?, ?, 'terminal-retention')`,
          [`${row.kind}:${row.id}`, row.kind, now],
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      const table = row.kind === 'job' ? 'settlement_jobs' : 'settlement_outbox';
      await new Promise<void>((resolve, reject) =>
        this.getDb().run(`DELETE FROM ${table} WHERE id = ?`, [row.id], (error) => (error ? reject(error) : resolve())),
      );
    }
    return candidates.length;
  }

  async updateSettlementState(
    matchId: number,
    state: 'processing' | 'completed' | 'failed' | 'superseded',
  ): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.getDb().run(
        `UPDATE settlement_jobs SET state = ?, updatedAt = ? WHERE matchId = ?`,
        [state, Date.now(), matchId],
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }

  async listActiveSettlementJobs(): Promise<
    Array<{
      matchId: number;
      gameId: string;
      platform: 'lichess' | 'chessdotcom';
      username?: string;
    }>
  > {
    const rows = await new Promise<any[]>((resolve, reject) =>
      this.getDb().all(
        `SELECT matchId, gameId, platform, payload FROM settlement_jobs WHERE state IN ('pending','processing') ORDER BY createdAt`,
        (error, result) => (error ? reject(error) : resolve(result)),
      ),
    );
    return rows.map((row) => {
      const payload = JSON.parse(row.payload);
      return {
        matchId: row.matchId,
        gameId: row.gameId,
        platform: row.platform,
        username: payload.player1Username ?? undefined,
      };
    });
  }

  async findByGameId(gameId: string): Promise<MatchRecord | null> {
    return new Promise((resolve, reject) => {
      this.getDb().get('SELECT * FROM matches WHERE gameId = ?', [gameId], (err: Error | null, row: any) => {
        if (err) {
          reject(err);
          return;
        }
        if (!row) {
          resolve(null);
          return;
        }
        resolve({
          matchId: row.matchId,
          player1: row.player1,
          player2: row.player2,
          player1Username: row.player1Username ?? undefined,
          player2Username: row.player2Username ?? undefined,
          stakeAmount: row.stakeAmount,
          token: row.token,
          gameId: row.gameId,
          platform: row.platform,
          state: row.state,
          identityHash: row.identityHash ?? undefined,
        });
      });
    });
  }

  async count(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.getDb().get('SELECT COUNT(*) AS count FROM matches', (err: Error | null, row: any) => {
        if (err) reject(err);
        else resolve(row?.count ?? 0);
      });
    });
  }

  clear(): void {
    this.getDb().run('DELETE FROM matches');
    this.nextId = 0;
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
