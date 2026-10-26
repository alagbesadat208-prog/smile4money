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

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }

        this.db!.run(
          `
          CREATE TABLE IF NOT EXISTS matches (
            matchId INTEGER PRIMARY KEY AUTOINCREMENT,
            player1 TEXT NOT NULL,
            player2 TEXT NOT NULL,
            player1Username TEXT,
            player2Username TEXT,
            stakeAmount REAL NOT NULL,
            token TEXT NOT NULL,
            gameId TEXT NOT NULL UNIQUE,
            platform TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'Pending',
            identityHash TEXT
          )
          `,
          (err: Error | null) => {
            if (err) {
              reject(err);
              return;
            }

            // Load nextId from the max existing matchId
            this.db!.get(
              'SELECT COALESCE(MAX(matchId), -1) + 1 AS nextId FROM matches',
              (err: Error | null, row: any) => {
                if (err) {
                  reject(err);
                  return;
                }
                this.nextId = row?.nextId ?? 0;
                this.initialized = true;
                resolve();
              },
            );
          },
        );
      });
    });
  }

  async createMatch(payload: CreateMatchPayload): Promise<MatchRecord> {
    if (!Number.isSafeInteger(this.nextId) || this.nextId < 0) {
      throw new Error('Match identifier range exhausted');
    }
    // #1720 — see match-store.ts's MatchStore.createMatch for the rationale;
    // kept identical here so both store implementations bind the same way.
    const identityHash =
      payload.player1Username && payload.player2Username
        ? computeIdentityHash(
            payload.player1Username,
            payload.player1,
            payload.player2Username,
            payload.player2,
          )
        : null;

    return new Promise((resolve, reject) => {
      const stmt = this.getDb().prepare(
        `INSERT INTO matches (matchId, player1, player2, player1Username, player2Username, stakeAmount, token, gameId, platform, state, identityHash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`,
      );

      const matchId = this.nextId++;
      stmt.run(
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
        function (this: sqlite3.RunResult, err: Error | null) {
          if (err) {
            reject(err);
            return;
          }
          resolve({
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
          });
        },
      );
      stmt.finalize();
    });
  }

  async findByGameId(gameId: string): Promise<MatchRecord | null> {
    return new Promise((resolve, reject) => {
      this.getDb().get(
        'SELECT * FROM matches WHERE gameId = ?',
        [gameId],
        (err: Error | null, row: any) => {
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
        },
      );
    });
  }

  async listMatches(): Promise<MatchRecord[]> {
    return new Promise((resolve, reject) => {
      this.getDb().all('SELECT * FROM matches ORDER BY matchId',
        (error, rows: MatchRecord[]) => error ? reject(error) : resolve(rows));
    });
  }

  async count(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.getDb().get(
        'SELECT COUNT(*) AS count FROM matches',
        (err: Error | null, row: any) => {
          if (err) reject(err);
          else resolve(row?.count ?? 0);
        },
      );
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
