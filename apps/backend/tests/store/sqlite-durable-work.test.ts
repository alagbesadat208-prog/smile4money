import { afterEach, describe, expect, it } from 'vitest';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { SqliteMatchStore } from '../../src/store/sqlite-match-store.js';
import { SQLiteQueueStore } from '../../src/store/sqlite-queue-store.js';
import { SqliteRateLimitStore } from '../../src/store/sqlite-rate-limit-store.js';
import { applySqliteMigrations } from '../../src/store/sqlite-migrations.js';

const dbPath = (name: string) =>
  path.join('/tmp', `durable-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const exec = (db: sqlite3.Database, sql: string, params: unknown[] = []) =>
  new Promise<void>((resolve, reject) => db.run(sql, params, (error) => (error ? reject(error) : resolve())));

describe('SQLite schema upgrades and durable settlement work', () => {
  const paths: string[] = [];
  const stores: Array<{
    close?: () => Promise<void>;
    destroy?: () => Promise<void>;
  }> = [];
  afterEach(async () => {
    delete process.env.DLQ_MAX_ENTRIES;
    await Promise.all(stores.splice(0).map((store) => (store.close?.() ?? store.destroy?.())?.catch(() => undefined)));
    for (const file of paths.splice(0))
      for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
  });

  it('rolls back a failed schema migration and its version marker', async () => {
    const file = dbPath('migration-rollback');
    paths.push(file);
    const db = new sqlite3.Database(file);
    await expect(
      applySqliteMigrations(db, [
        {
          version: 1,
          name: 'will-fail',
          statements: ['CREATE TABLE partial_change(id INTEGER PRIMARY KEY)', 'CREATE TABLE invalid('],
        },
      ]),
    ).rejects.toThrow();
    const rows = await new Promise<any[]>((resolve, reject) =>
      db.all("SELECT name FROM sqlite_master WHERE name = 'partial_change'", (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
    const version = await new Promise<number>((resolve, reject) =>
      db.get('SELECT MAX(version) AS version FROM schema_version', (error, row: any) =>
        error ? reject(error) : resolve(row.version ?? 0),
      ),
    );
    await new Promise<void>((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
    expect(rows).toEqual([]);
    expect(version).toBe(0);
  });

  it('upgrades a legacy match file and version-one queue and rate-limit schemas', async () => {
    const matchPath = dbPath('match-v1');
    paths.push(matchPath);
    const matchFixture = new sqlite3.Database(matchPath);
    // Version zero represents the deployed pre-migration database, which had
    // the matches table but no schema ledger.
    await exec(
      matchFixture,
      `CREATE TABLE matches (matchId INTEGER PRIMARY KEY AUTOINCREMENT, player1 TEXT NOT NULL, player2 TEXT NOT NULL, player1Username TEXT, player2Username TEXT, stakeAmount REAL NOT NULL, token TEXT NOT NULL, gameId TEXT NOT NULL UNIQUE, platform TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'Pending', identityHash TEXT)`,
    );
    await exec(
      matchFixture,
      "INSERT INTO matches(player1,player2,stakeAmount,token,gameId,platform) VALUES ('a','b',1,'XLM','old-game','lichess')",
    );
    await new Promise<void>((resolve, reject) => matchFixture.close((e) => (e ? reject(e) : resolve())));
    const matchStore = new SqliteMatchStore(matchPath);
    stores.push(matchStore);
    await matchStore.initialize();
    expect(await matchStore.count()).toBe(1);
    expect(await matchStore.dispatchOutbox(async () => {})).toBe(0);

    const queuePath = dbPath('queue-v1');
    paths.push(queuePath);
    const queueFixture = new sqlite3.Database(queuePath);
    await exec(
      queueFixture,
      'CREATE TABLE schema_version(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
    );
    await exec(queueFixture, "INSERT INTO schema_version VALUES (1, 'create-dlq', 1)");
    await exec(
      queueFixture,
      'CREATE TABLE oracle_dlq (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, failureReason TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, lastAttemptAt INTEGER, expireAt INTEGER NOT NULL)',
    );
    await exec(queueFixture, 'CREATE INDEX idx_oracle_dlq_expireAt ON oracle_dlq(expireAt)');
    await new Promise<void>((resolve, reject) => queueFixture.close((e) => (e ? reject(e) : resolve())));
    const queue = new SQLiteQueueStore(queuePath);
    stores.push(queue);
    await queue.initialize();
    await queue.add({
      id: 'terminal',
      payload: {},
      failureReason: 'failed',
      attempts: 0,
      createdAt: Date.now(),
      lastAttemptAt: null,
    });
    expect(await queue.count()).toBe(1);
    process.env.DLQ_MAX_ENTRIES = '2';
    for (const id of ['older', 'newer'])
      await queue.add({
        id,
        payload: {},
        failureReason: 'failed',
        attempts: 0,
        createdAt: Date.now() + (id === 'newer' ? 1 : 0),
        lastAttemptAt: null,
      });
    expect(await queue.count()).toBe(2);
    const queueDb = new sqlite3.Database(queuePath);
    const archive = await new Promise<any[]>((resolve, reject) =>
      queueDb.all('SELECT id, reason FROM oracle_dlq_audit', (error, rows) => (error ? reject(error) : resolve(rows))),
    );
    await new Promise<void>((resolve, reject) => queueDb.close((e) => (e ? reject(e) : resolve())));
    expect(archive).toHaveLength(1);

    const ratePath = dbPath('rate-v1');
    paths.push(ratePath);
    const rateFixture = new sqlite3.Database(ratePath);
    await exec(
      rateFixture,
      'CREATE TABLE schema_version(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
    );
    await exec(rateFixture, "INSERT INTO schema_version VALUES (1, 'create-rate-limit-buckets', 1)");
    await exec(
      rateFixture,
      'CREATE TABLE rate_limit_buckets(clientId TEXT PRIMARY KEY NOT NULL, tokens REAL NOT NULL, lastRefill INTEGER NOT NULL)',
    );
    await new Promise<void>((resolve, reject) => rateFixture.close((e) => (e ? reject(e) : resolve())));
    const rate = new SqliteRateLimitStore(2, 1000, 2, ratePath);
    stores.push(rate);
    await rate.initialize();
    expect((await rate.isAllowed('upgraded')).allowed).toBe(true);
  });

  it('applies the audit migration to a version-two match database', async () => {
    const file = dbPath('match-v2');
    paths.push(file);
    const fixture = new sqlite3.Database(file);
    await exec(
      fixture,
      'CREATE TABLE schema_version(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
    );
    await exec(fixture, "INSERT INTO schema_version VALUES (1, 'create-matches', 1)");
    await exec(fixture, "INSERT INTO schema_version VALUES (2, 'settlement-outbox-and-jobs', 2)");
    await exec(
      fixture,
      `CREATE TABLE matches (matchId INTEGER PRIMARY KEY AUTOINCREMENT, player1 TEXT NOT NULL, player2 TEXT NOT NULL, player1Username TEXT, player2Username TEXT, stakeAmount REAL NOT NULL, token TEXT NOT NULL, gameId TEXT NOT NULL UNIQUE, platform TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'Pending', identityHash TEXT)`,
    );
    await exec(
      fixture,
      `CREATE TABLE settlement_jobs (id TEXT PRIMARY KEY NOT NULL, matchId INTEGER NOT NULL UNIQUE REFERENCES matches(matchId), gameId TEXT NOT NULL, platform TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
    );
    await exec(
      fixture,
      `CREATE TABLE settlement_outbox (id TEXT PRIMARY KEY NOT NULL, eventType TEXT NOT NULL, aggregateId TEXT NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL, dispatchedAt INTEGER, attempts INTEGER NOT NULL DEFAULT 0)`,
    );
    await exec(fixture, 'CREATE INDEX idx_settlement_outbox_pending ON settlement_outbox(dispatchedAt, createdAt)');
    await exec(fixture, 'CREATE INDEX idx_settlement_jobs_state ON settlement_jobs(state, updatedAt)');
    await new Promise<void>((resolve, reject) => fixture.close((e) => (e ? reject(e) : resolve())));
    const store = new SqliteMatchStore(file);
    stores.push(store);
    await store.initialize();
    const db = new sqlite3.Database(file);
    const version = await new Promise<number>((resolve, reject) =>
      db.get('SELECT MAX(version) AS version FROM schema_version', (error, row: any) =>
        error ? reject(error) : resolve(row.version),
      ),
    );
    await new Promise<void>((resolve, reject) => db.close((e) => (e ? reject(e) : resolve())));
    expect(version).toBe(3);
  });

  it('rolls back the match when settlement-job insertion fails', async () => {
    const file = dbPath('atomic');
    paths.push(file);
    const store = new SqliteMatchStore(file);
    stores.push(store);
    await store.initialize();
    const fixture = new sqlite3.Database(file);
    await exec(
      fixture,
      `CREATE TRIGGER reject_settlement_job BEFORE INSERT ON settlement_jobs BEGIN SELECT RAISE(ABORT, 'injected job failure'); END`,
    );
    await new Promise<void>((resolve, reject) => fixture.close((e) => (e ? reject(e) : resolve())));
    await expect(
      store.createMatch({
        player1: 'a',
        player2: 'b',
        stakeAmount: 1,
        token: 'XLM',
        gameId: 'fail-game',
        platform: 'lichess',
      }),
    ).rejects.toThrow();
    expect(await store.count()).toBe(0);
    const check = new sqlite3.Database(file);
    const jobs = await new Promise<any[]>((resolve, reject) =>
      check.all("SELECT id FROM settlement_jobs WHERE gameId = 'fail-game'", (error, rows) =>
        error ? reject(error) : resolve(rows),
      ),
    );
    await new Promise<void>((resolve, reject) => check.close((e) => (e ? reject(e) : resolve())));
    expect(jobs).toEqual([]);
  });

  it('rolls back both match and job when outbox insertion fails', async () => {
    const file = dbPath('atomic-outbox');
    paths.push(file);
    const store = new SqliteMatchStore(file);
    stores.push(store);
    await store.initialize();
    const fixture = new sqlite3.Database(file);
    await exec(
      fixture,
      `CREATE TRIGGER reject_outbox BEFORE INSERT ON settlement_outbox BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END`,
    );
    await new Promise<void>((resolve, reject) => fixture.close((e) => (e ? reject(e) : resolve())));
    await expect(
      store.createMatch({
        player1: 'a',
        player2: 'b',
        stakeAmount: 1,
        token: 'XLM',
        gameId: 'outbox-fail',
        platform: 'lichess',
      }),
    ).rejects.toThrow();
    expect(await store.count()).toBe(0);
    const check = new sqlite3.Database(file);
    const jobs = await new Promise<any[]>((resolve, reject) =>
      check.all("SELECT id FROM settlement_jobs WHERE gameId = 'outbox-fail'", (error, rows) =>
        error ? reject(error) : resolve(rows),
      ),
    );
    await new Promise<void>((resolve, reject) => check.close((e) => (e ? reject(e) : resolve())));
    expect(jobs).toEqual([]);
  });

  it('replays an outbox event after simulated termination and dispatches it only once after acknowledgement', async () => {
    const file = dbPath('recovery');
    paths.push(file);
    const writer = new SqliteMatchStore(file);
    stores.push(writer);
    await writer.initialize();
    await writer.createMatch({
      player1: 'a',
      player2: 'b',
      stakeAmount: 1,
      token: 'XLM',
      gameId: 'recover-game',
      platform: 'lichess',
    });
    // Simulate process termination after commit but before dispatch.
    await writer.close();
    const store = new SqliteMatchStore(file);
    stores.push(store);
    await store.initialize();
    expect(await store.listActiveSettlementJobs()).toEqual([
      {
        matchId: 0,
        gameId: 'recover-game',
        platform: 'lichess',
        username: undefined,
      },
    ]);
    let deliveries = 0;
    await expect(
      store.dispatchOutbox(async (event) => {
        expect(event.id).toBe('settlement:recover-game');
        deliveries += 1;
        throw new Error('simulated dispatcher interruption');
      }),
    ).rejects.toThrow('simulated dispatcher interruption');
    expect(
      await store.dispatchOutbox(async (event) => {
        expect(event.id).toBe('settlement:recover-game');
        deliveries += 1;
      }),
    ).toBe(1);
    expect(
      await store.dispatchOutbox(async () => {
        deliveries += 1;
      }),
    ).toBe(0);
    expect(deliveries).toBe(2);
  });

  it('retains active settlement jobs while archiving terminal work in bounded batches', async () => {
    const file = dbPath('retention');
    paths.push(file);
    const store = new SqliteMatchStore(file);
    stores.push(store);
    await store.initialize();
    await store.createMatch({
      player1: 'a',
      player2: 'b',
      stakeAmount: 1,
      token: 'XLM',
      gameId: 'active-game',
      platform: 'lichess',
    });
    await store.createMatch({
      player1: 'a',
      player2: 'c',
      stakeAmount: 1,
      token: 'XLM',
      gameId: 'done-game',
      platform: 'lichess',
    });
    await store.updateSettlementState(1, 'completed');
    const fixture = new sqlite3.Database(file);
    await exec(fixture, 'UPDATE settlement_jobs SET updatedAt = 1 WHERE matchId = 1');
    await new Promise<void>((resolve, reject) => fixture.close((e) => (e ? reject(e) : resolve())));
    const deleted = await store.cleanupTerminalWork(Date.now(), 1);
    expect(deleted).toBe(1);
    const check = new sqlite3.Database(file);
    const states = await new Promise<any[]>((resolve, reject) =>
      check.all('SELECT state FROM settlement_jobs ORDER BY matchId', (error, rows) =>
        error ? reject(error) : resolve(rows),
      ),
    );
    const audit = await new Promise<any[]>((resolve, reject) =>
      check.all('SELECT recordId FROM settlement_work_audit', (error, rows) => (error ? reject(error) : resolve(rows))),
    );
    await new Promise<void>((resolve, reject) => check.close((e) => (e ? reject(e) : resolve())));
    expect(states).toEqual([{ state: 'pending' }]);
    expect(audit).toEqual([{ recordId: 'job:settlement:done-game' }]);
  });
});
