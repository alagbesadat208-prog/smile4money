/**
 * Storage capacity limits and disk-pressure alarms (#105).
 *
 * Covers measuring database size (including WAL files), the configured
 * thresholds, the alarm levels the monitor logs, and that reclaiming space
 * never deletes pending settlements.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SQLiteQueueStore } from '../../src/store/sqlite-queue-store.js';
import type { DlqEntry } from '../../src/store/persistent-queue-store.js';
import {
  DEFAULT_CAPACITY_CONFIG,
  checkStorage,
  databaseBytes,
  parseCapacityConfig,
  reclaimSpace,
  startStorageCapacityMonitor,
  type CapacityConfig,
} from '../../src/store/storage-capacity.js';

let dir: string;
const plenty = () => 10 * 1024 * 1024 * 1024;

function config(overrides: Partial<CapacityConfig> = {}): CapacityConfig {
  return { ...DEFAULT_CAPACITY_CONFIG, capacityBytes: 1000, minFreeBytes: 100, ...overrides };
}

function file(name: string, bytes: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-capacity-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('measuring storage', () => {
  it('counts the database with its WAL and shared-memory files', () => {
    const db = file('queue.db', 100);
    file('queue.db-wal', 50);
    file('queue.db-shm', 25);
    expect(databaseBytes(db)).toBe(175);
    expect(databaseBytes(path.join(dir, 'missing.db'))).toBe(0);
  });

  it('sums every database against the budget', () => {
    const a = file('a.db', 300);
    const b = file('b.db', 200);
    const report = checkStorage([a, b], config(), plenty);
    expect(report.totalBytes).toBe(500);
    expect(report.usedRatio).toBe(0.5);
    expect(report.level).toBe('ok');
  });
});

describe('thresholds', () => {
  it('warns at the warning ratio', () => {
    const report = checkStorage([file('a.db', 800)], config(), plenty);
    expect(report.level).toBe('warning');
    expect(report.reasons[0]).toMatch(/80\.0% of the 1000-byte budget/);
  });

  it('is critical at the critical ratio', () => {
    expect(checkStorage([file('a.db', 950)], config(), plenty).level).toBe('critical');
  });

  it('is critical when the volume is nearly full, whatever the budget says', () => {
    const report = checkStorage([file('a.db', 10)], config(), () => 50);
    expect(report.level).toBe('critical');
    expect(report.reasons.join(' ')).toMatch(/50 bytes free/);
  });

  it('reads configuration and rejects invalid values', () => {
    expect(
      parseCapacityConfig({
        STORAGE_CAPACITY_BYTES: '2048',
        STORAGE_WARN_RATIO: '0.5',
        STORAGE_CRITICAL_RATIO: '0.9',
        STORAGE_MIN_FREE_BYTES: '10',
        STORAGE_CHECK_INTERVAL_MS: '1000',
      }),
    ).toEqual({
      capacityBytes: 2048,
      warnRatio: 0.5,
      criticalRatio: 0.9,
      minFreeBytes: 10,
      intervalMs: 1000,
    });

    const fallback = parseCapacityConfig({
      STORAGE_CAPACITY_BYTES: 'lots',
      STORAGE_WARN_RATIO: '2',
      STORAGE_CRITICAL_RATIO: '-1',
    });
    expect(fallback.capacityBytes).toBe(DEFAULT_CAPACITY_CONFIG.capacityBytes);
    expect(fallback.warnRatio).toBe(DEFAULT_CAPACITY_CONFIG.warnRatio);
    expect(fallback.criticalRatio).toBe(DEFAULT_CAPACITY_CONFIG.criticalRatio);
  });

  it('keeps the critical ratio above the warning ratio', () => {
    const c = parseCapacityConfig({ STORAGE_WARN_RATIO: '0.9', STORAGE_CRITICAL_RATIO: '0.5' });
    expect(c.criticalRatio).toBeGreaterThan(c.warnRatio);
  });
});

describe('monitor alarms', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it('logs the metric every run and alarms before exhaustion', () => {
    const log = logger();
    const stop = startStorageCapacityMonitor(
      [file('a.db', 850)],
      log,
      config({ intervalMs: 60_000 }),
    );
    stop();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'storage_capacity', level: 'warning', total_bytes: 850 }),
      'storage_capacity',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warning' }),
      'storage_capacity_warning',
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('raises a critical alarm', () => {
    const log = logger();
    startStorageCapacityMonitor([file('a.db', 990)], log, config({ intervalMs: 60_000 }))();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'critical' }),
      'storage_capacity_critical',
    );
  });

  it('stays quiet when there is room', () => {
    const log = logger();
    startStorageCapacityMonitor(
      [file('a.db', 10)],
      log,
      config({ intervalMs: 60_000, minFreeBytes: 1 }),
    )();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('reclaiming space never deletes pending work', () => {
  it('compacts the database and keeps every pending settlement', async () => {
    const dbPath = path.join(dir, 'oracle-queue.db');
    const store = new SQLiteQueueStore(dbPath);
    await store.initialize();
    const filler = 'x'.repeat(4096);
    for (let i = 0; i < 60; i++) {
      await store.add({
        id: `e${i}`,
        payload: { matchId: i, filler },
        failureReason: 'rpc timeout',
        attempts: 1,
        createdAt: Date.now(),
        lastAttemptAt: null,
      } satisfies DlqEntry);
    }
    // Resolve most entries so there is free space to give back.
    for (let i = 0; i < 50; i++) await store.remove(`e${i}`);
    await store.close();

    const { before, after } = await reclaimSpace(dbPath);
    expect(after).toBeLessThan(before);

    const reopened = new SQLiteQueueStore(dbPath);
    await reopened.initialize();
    const ids = (await reopened.getAll()).map((e) => e.id).sort();
    await reopened.close();
    expect(ids).toEqual(['e50', 'e51', 'e52', 'e53', 'e54', 'e55', 'e56', 'e57', 'e58', 'e59']);
  });
});
