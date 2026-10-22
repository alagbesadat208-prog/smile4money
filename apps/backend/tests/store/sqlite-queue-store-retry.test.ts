/**
 * Tests for SQLite retry-with-backoff on lock contention (#52).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  SQLiteQueueStore,
  isRetryableSqliteError,
  withRetry,
  type SqliteError,
} from '../../src/store/sqlite-queue-store.js';
import type { DlqEntry } from '../../src/store/persistent-queue-store.js';

function sqliteError(code: string, message = 'database is locked'): SqliteError {
  const err = new Error(message) as SqliteError;
  err.code = code;
  return err;
}

describe('isRetryableSqliteError (#52)', () => {
  it('treats SQLITE_BUSY as retryable', () => {
    expect(isRetryableSqliteError(sqliteError('SQLITE_BUSY'))).toBe(true);
  });

  it('treats SQLITE_LOCKED as retryable', () => {
    expect(isRetryableSqliteError(sqliteError('SQLITE_LOCKED'))).toBe(true);
  });

  it('does not treat an unrelated SQLite error as retryable', () => {
    expect(isRetryableSqliteError(sqliteError('SQLITE_CONSTRAINT'))).toBe(false);
  });

  it('does not treat a plain Error (no code) as retryable', () => {
    expect(isRetryableSqliteError(new Error('boom'))).toBe(false);
  });

  it('does not treat a non-error value as retryable', () => {
    expect(isRetryableSqliteError('some string')).toBe(false);
    expect(isRetryableSqliteError(undefined)).toBe(false);
  });
});

describe('withRetry (#52)', () => {
  const originalMaxRetries = process.env.SQLITE_MAX_RETRIES;
  const originalBaseDelay = process.env.SQLITE_RETRY_BASE_DELAY_MS;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.SQLITE_MAX_RETRIES = '3';
    process.env.SQLITE_RETRY_BASE_DELAY_MS = '10';
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalMaxRetries === undefined) delete process.env.SQLITE_MAX_RETRIES;
    else process.env.SQLITE_MAX_RETRIES = originalMaxRetries;
    if (originalBaseDelay === undefined) delete process.env.SQLITE_RETRY_BASE_DELAY_MS;
    else process.env.SQLITE_RETRY_BASE_DELAY_MS = originalBaseDelay;
    vi.restoreAllMocks();
  });

  it('resolves immediately when the operation succeeds on the first attempt', async () => {
    const operation = vi.fn((cb: (err: Error | null, result?: string) => void) => cb(null, 'ok'));
    const result = await withRetry('test-op', operation);
    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries on SQLITE_BUSY and succeeds once the lock clears, logging before each retry', async () => {
    // logger.ts's warn() always writes a JSON string via console.log,
    // regardless of level -- see src/logger.ts.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let calls = 0;
    const operation = vi.fn((cb: (err: Error | null, result?: string) => void) => {
      calls += 1;
      if (calls < 3) {
        cb(sqliteError('SQLITE_BUSY'));
      } else {
        cb(null, 'ok');
      }
    });

    const promise = withRetry('test-op', operation);
    // Two retries needed (fails on attempt 1 and 2, succeeds on attempt 3).
    await vi.advanceTimersByTimeAsync(10); // after first backoff (10ms)
    await vi.advanceTimersByTimeAsync(20); // after second backoff (20ms)

    const result = await promise;
    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);

    // Logged the SQLite error code/message before each of the two retries.
    const retryLogs = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .filter((entry) => entry.message === 'sqlite_operation_retrying');
    expect(retryLogs).toHaveLength(2);
    for (const entry of retryLogs) {
      expect(entry.sqlite_error_code).toBe('SQLITE_BUSY');
      expect(entry.sqlite_error_message).toBeUndefined();
    }
  });

  it('gives up after the configured maximum retries and surfaces the error', async () => {
    const busyError = sqliteError('SQLITE_BUSY');
    const operation = vi.fn((cb: (err: Error | null) => void) => cb(busyError));

    const promise = withRetry('test-op', operation).catch((e) => e);
    // 3 retries configured -> 3 backoff waits after the initial attempt.
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(40);

    const result = await promise;
    expect(result).toBe(busyError);
    // Initial attempt + 3 retries = 4 total calls.
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('does not retry a non-retryable error', async () => {
    const constraintError = sqliteError('SQLITE_CONSTRAINT', 'UNIQUE constraint failed');
    const operation = vi.fn((cb: (err: Error | null) => void) => cb(constraintError));

    await expect(withRetry('test-op', operation)).rejects.toBe(constraintError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff: each retry delay doubles the previous one', async () => {
    const busyError = sqliteError('SQLITE_BUSY');
    const operation = vi.fn((cb: (err: Error | null) => void) => cb(busyError));
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const promise = withRetry('test-op', operation).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(40);
    await promise;

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toEqual([10, 20, 40]);
  });
});

describe('SQLiteQueueStore retry integration (#52)', () => {
  let dbPath: string;
  let store: SQLiteQueueStore;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.SQLITE_MAX_RETRIES = '5';
    process.env.SQLITE_RETRY_BASE_DELAY_MS = '10';
    dbPath = path.join('/tmp', `test-retry-oracle-queue-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new SQLiteQueueStore(dbPath);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await store.close().catch(() => undefined);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    delete process.env.SQLITE_MAX_RETRIES;
    delete process.env.SQLITE_RETRY_BASE_DELAY_MS;
    vi.restoreAllMocks();
  });

  it('add() succeeds after transient SQLITE_BUSY errors from the underlying db.run', async () => {
    await store.initialize();

    // Patch the live db instance so its first two `run` calls (for this
    // insert) fail with a locked-file error, then behave normally.
    const db = (store as unknown as { db: { run: (...args: unknown[]) => unknown } }).db;
    const originalRun = db.run.bind(db);
    let runCalls = 0;
    vi.spyOn(db, 'run').mockImplementation((...args: unknown[]) => {
      runCalls += 1;
      const cb = args[args.length - 1] as (err: Error | null) => void;
      if (runCalls <= 2) {
        cb(sqliteError('SQLITE_BUSY', 'database is locked'));
        return db;
      }
      return originalRun(...args);
    });

    const entry: DlqEntry = {
      id: 'evt-1',
      payload: { hello: 'world' },
      failureReason: 'test',
      attempts: 0,
      createdAt: Date.now(),
      lastAttemptAt: null,
    };

    const addPromise = store.add(entry);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await addPromise;

    expect(runCalls).toBeGreaterThanOrEqual(3);
  });
});
