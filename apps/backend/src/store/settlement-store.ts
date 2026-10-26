import sqlite3 from "sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { OracleSubmission } from "../services/oracle-submit.js";

export interface SettlementRecord {
  matchId: number;
  gameId: string;
  state: "active" | "pending" | "submitted" | "confirmed" | "quarantined";
  submission?: OracleSubmission;
  transaction?: { hash: string; envelope: string; expiresAt: number };
  chainStatus?: "SUCCESS" | "FAILED" | "NOT_FOUND";
  attempts: number;
  nextAttemptAt: number;
  error?: string;
}

/** Durable outbox, scoped to a network and escrow contract. Never TTL-evicted. */
export class SettlementStore {
  private db!: sqlite3.Database;
  constructor(
    private path: string,
    private scope: string,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const db = new sqlite3.Database(this.path, (error) =>
        error ? reject(error) : resolve(db),
      );
    });
    await this.run("PRAGMA journal_mode = WAL");
    await this.run("PRAGMA synchronous = FULL");
    await this.run(`CREATE TABLE IF NOT EXISTS settlements (
      scope TEXT NOT NULL, match_id INTEGER NOT NULL, game_id TEXT NOT NULL,
      record TEXT NOT NULL, PRIMARY KEY (scope, match_id, game_id))`);
  }

  private run(sql: string, args: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, args, (error) => (error ? reject(error) : resolve()));
    });
  }

  async enqueue(matchId: number, gameId: string): Promise<void> {
    const record: SettlementRecord = {
      matchId,
      gameId,
      state: "active",
      attempts: 0,
      nextAttemptAt: 0,
    };
    await this.run("INSERT OR IGNORE INTO settlements VALUES (?, ?, ?, ?)", [
      this.scope,
      matchId,
      gameId,
      JSON.stringify(record),
    ]);
  }

  async save(record: SettlementRecord): Promise<void> {
    await this.run(
      "UPDATE settlements SET record = ? WHERE scope = ? AND match_id = ? AND game_id = ?",
      [JSON.stringify(record), this.scope, record.matchId, record.gameId],
    );
  }

  async list(): Promise<SettlementRecord[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT record FROM settlements WHERE scope = ? ORDER BY match_id",
        [this.scope],
        (error, rows: { record: string }[]) =>
          error
            ? reject(error)
            : resolve(rows.map((row) => JSON.parse(row.record))),
      );
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.db.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
