import sqlite3 from 'sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Evidence } from '../fetchers/result.js';

export interface Decision {
  id?: number;
  matchId: number;
  gameId: string;
  state: 'review_required' | 'verified' | 'in_progress' | 'retry_requested';
  reason: string;
  evidence?: Evidence;
  recordedAt: string;
  operator?: string;
}
export interface EvidenceStore {
  history(gameId: string): Promise<Decision[]>;
  append(decision: Decision): Promise<number>;
}

export class MemoryEvidenceStore implements EvidenceStore {
  private entries: Decision[] = [];
  async history(gameId: string): Promise<Decision[]> {
    return this.entries
      .filter((e) => e.gameId === gameId)
      .map((e) => structuredClone(e));
  }
  async append(decision: Decision): Promise<number> {
    const id = this.entries.length + 1;
    this.entries.push(structuredClone({ ...decision, id }));
    return id;
  }
}

/** Append-only, minimal evidence ledger; no raw provider responses or usernames. */
export class SqliteEvidenceStore implements EvidenceStore {
  private db?: sqlite3.Database;
  constructor(private filename: string) {}
  async initialize(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      this.db = new sqlite3.Database(this.filename, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    await new Promise<void>((resolve, reject) =>
      this.db!.run(
        `CREATE TABLE IF NOT EXISTS oracle_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, gameId TEXT NOT NULL, decision TEXT NOT NULL)`,
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    await new Promise<void>((resolve, reject) =>
      this.db!.run(
        'CREATE INDEX IF NOT EXISTS oracle_decisions_game ON oracle_decisions(gameId, id)',
        (err) => (err ? reject(err) : resolve()),
      ),
    );
  }
  async history(gameId: string): Promise<Decision[]> {
    if (!this.db) throw new Error('Evidence store not initialized');
    return new Promise((resolve, reject) =>
      this.db!.all(
        'SELECT id, decision FROM oracle_decisions WHERE gameId = ? ORDER BY id',
        [gameId],
        (err, rows: { id: number; decision: string }[]) =>
          err
            ? reject(err)
            : resolve(
                rows.map((r) => ({ ...JSON.parse(r.decision), id: r.id })),
              ),
      ),
    );
  }
  async append(decision: Decision): Promise<number> {
    if (!this.db) throw new Error('Evidence store not initialized');
    return new Promise((resolve, reject) =>
      this.db!.run(
        'INSERT INTO oracle_decisions(gameId, decision) VALUES (?, ?)',
        [decision.gameId, JSON.stringify(decision)],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        },
      ),
    );
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.db) return resolve();
      this.db.close((err) => (err ? reject(err) : resolve()));
    });
    this.db = undefined;
  }
}

/** Serialize verification and operator actions for the same game in this process. */
const locks = new Map<string, Promise<unknown>>();
export async function withGameLock<T>(
  gameId: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(gameId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  locks.set(gameId, current);
  try {
    return await current;
  } finally {
    if (locks.get(gameId) === current) locks.delete(gameId);
  }
}
