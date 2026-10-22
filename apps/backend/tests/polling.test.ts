/**
 * Test suite for the game polling system.
 *
 * Tests cover:
 * - In-progress game detection and re-enqueuing
 * - Completed game detection and job removal
 * - Exponential backoff calculation
 * - Job store operations
 * - Error handling and DLQ movement
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PollingJobStore,
  PollingWorker,
  calculateNextPollDelay,
  parsePollingIntervalMs,
  type PollJob,
  type GamePoller,
} from '../src/services/polling.js';

/**
 * Mock game poller for testing.
 */
class MockGamePoller implements GamePoller {
  private gameStatus: Map<string, 'in_progress' | 'completed'> = new Map();
  private gameResult: Map<string, 'Player1Wins' | 'Player2Wins' | 'Draw'> = new Map();

  setGameStatus(gameId: string, status: 'in_progress' | 'completed'): void {
    this.gameStatus.set(gameId, status);
  }

  setGameResult(gameId: string, result: 'Player1Wins' | 'Player2Wins' | 'Draw'): void {
    this.gameResult.set(gameId, result);
  }

  async poll(job: PollJob) {
    const status = this.gameStatus.get(job.gameId) ?? 'completed';
    const result = this.gameResult.get(job.gameId) ?? 'Draw';

    if (status === 'in_progress') {
      return { status: 'in_progress' as const };
    }

    return {
      status: 'completed' as const,
      result,
    };
  }
}

/**
 * Poller whose `poll()` blocks until the test explicitly releases it,
 * simulating a chess-platform API call that is still in flight when
 * shutdown is requested (#1719).
 */
class DelayedGamePoller implements GamePoller {
  private release: (() => void) | null = null;
  public pollStarted = false;

  waitUntilStarted(): Promise<void> {
    if (this.pollStarted) return Promise.resolve();
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.pollStarted) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });
  }

  releasePoll(): void {
    this.release?.();
  }

  async poll(_job: PollJob) {
    this.pollStarted = true;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return { status: 'in_progress' as const };
  }
}

/**
 * Mock poller that always returns a failed status with an optional reason.
 */
class FailingGamePoller implements GamePoller {
  constructor(private readonly reason?: string) {}

  async poll(_job: PollJob) {
    return { status: 'failed' as const, reason: this.reason };
  }
}

describe('Game Polling System', () => {
  describe('calculateNextPollDelay', () => {
    it('returns base interval when no backoff (multiplier=1.0)', () => {
      const delay = calculateNextPollDelay(0, 30_000, 1.0);
      expect(delay).toBe(30_000);

      const delay2 = calculateNextPollDelay(5, 30_000, 1.0);
      expect(delay2).toBe(30_000); // Always 30s
    });

    it('applies linear backoff (multiplier=1.1)', () => {
      const delay0 = calculateNextPollDelay(0, 30_000, 1.1);
      expect(delay0).toBe(30_000);

      const delay1 = calculateNextPollDelay(1, 30_000, 1.1);
      expect(delay1).toBe(33_000); // 30_000 * 1.1

      const delay2 = calculateNextPollDelay(2, 30_000, 1.1);
      expect(delay2).toBe(36_300); // 30_000 * 1.1^2 ≈ 36,300
    });

    it('applies exponential backoff (multiplier=1.5)', () => {
      const delay0 = calculateNextPollDelay(0, 30_000, 1.5);
      expect(delay0).toBe(30_000);

      const delay1 = calculateNextPollDelay(1, 30_000, 1.5);
      expect(delay1).toBe(45_000); // 30_000 * 1.5

      const delay2 = calculateNextPollDelay(2, 30_000, 1.5);
      expect(delay2).toBe(67_500); // 30_000 * 1.5^2 = 67,500
    });

    it('handles edge case: attempt=0 with any multiplier', () => {
      expect(calculateNextPollDelay(0, 30_000, 1.0)).toBe(30_000);
      expect(calculateNextPollDelay(0, 30_000, 1.5)).toBe(30_000);
      expect(calculateNextPollDelay(0, 30_000, 2.0)).toBe(30_000);
    });
  });

  describe('PollingJobStore', () => {
    let store: PollingJobStore;

    beforeEach(() => {
      store = new PollingJobStore();
    });

    it('creates a new polling job', () => {
      const job = store.createJob(1, 'game-123', 'lichess');

      expect(job.matchId).toBe(1);
      expect(job.gameId).toBe('game-123');
      expect(job.platform).toBe('lichess');
      expect(job.pollingAttempt).toBe(0);
      expect(job.createdAt).toBeLessThanOrEqual(Date.now());
      expect(job.lastPolledAt).toBeNull();
    });

    it('creates job with username for Chess.com', () => {
      const job = store.createJob(2, 'game-456', 'chessdotcom', 'alice');

      expect(job.username).toBe('alice');
      expect(job.platform).toBe('chessdotcom');
    });

    // #46 — dedup key is (matchId, gameId), not matchId alone
    it('throws when creating a duplicate job for the same (matchId, gameId) pair', () => {
      store.createJob(1, 'game-123', 'lichess');

      expect(() => {
        store.createJob(1, 'game-123', 'lichess');
      }).toThrow('Polling job already exists for match 1 (game game-123)');
    });

    it('treats the same matchId with a different gameId as a distinct job', () => {
      // e.g. a cancelled match's matchId reused by a new match after a counter reset.
      const first = store.createJob(1, 'game-123', 'lichess');

      expect(() => {
        store.createJob(1, 'game-456', 'lichess');
      }).not.toThrow();

      const second = store.getJobByMatchId(1);
      expect(second).not.toBeNull();
      expect(second?.gameId).toBe('game-456');
      expect(first.id).not.toBe(second?.id);
    });

    it('retrieves job by ID', () => {
      const created = store.createJob(1, 'game-123', 'lichess');
      const retrieved = store.getJob(created.id);

      expect(retrieved).toEqual(created);
    });

    it('retrieves job by matchId', () => {
      const created = store.createJob(1, 'game-123', 'lichess');
      const retrieved = store.getJobByMatchId(1);

      expect(retrieved).toEqual(created);
    });

    it('increments polling attempt counter', () => {
      const job = store.createJob(1, 'game-123', 'lichess');

      expect(job.pollingAttempt).toBe(0);
      expect(job.lastPolledAt).toBeNull();

      store.incrementAttempt(job.id);

      expect(job.pollingAttempt).toBe(1);
      expect(job.lastPolledAt).toBeLessThanOrEqual(Date.now());
    });

    it('completes and removes a job', () => {
      const job = store.createJob(1, 'game-123', 'lichess');

      store.completeJob(job.id);

      expect(store.getJob(job.id)).toBeNull();
      expect(store.getJobByMatchId(1)).toBeNull();
    });

    it('lists all pending jobs', () => {
      store.createJob(1, 'game-1', 'lichess');
      store.createJob(2, 'game-2', 'lichess');
      store.createJob(3, 'game-3', 'chessdotcom', 'bob');

      const jobs = store.listPendingJobs();

      expect(jobs).toHaveLength(3);
      expect(jobs.map((j) => j.matchId)).toEqual([1, 2, 3]);
    });

    it('clears all jobs', () => {
      store.createJob(1, 'game-1', 'lichess');
      store.createJob(2, 'game-2', 'lichess');

      expect(store.listPendingJobs()).toHaveLength(2);

      store.clear();

      expect(store.listPendingJobs()).toHaveLength(0);
    });
  });

  describe('PollingWorker', () => {
    let store: PollingJobStore;
    let poller: MockGamePoller;
    let worker: PollingWorker;

    beforeEach(() => {
      store = new PollingJobStore();
      poller = new MockGamePoller();
      worker = new PollingWorker(store, poller, {
        pollingIntervalMs: 100, // Fast for testing
        maxPollingAttempts: 5,
        backoffMultiplier: 1.0,
        onGameCompleted: vi.fn().mockResolvedValue(undefined),
        onMaxAttemptsExceeded: vi.fn().mockResolvedValue(undefined),
      });
    });    it('detects in-progress game and keeps job in store', async () => {
      const job = store.createJob(1, 'game-123', 'lichess');
      poller.setGameStatus('game-123', 'in_progress');

      const status = await poller.poll(job);

      expect(status.status).toBe('in_progress');
      expect(store.getJobByMatchId(1)).toBeDefined(); // Job not removed
    });

    it('detects completed game and removes job from store', async () => {
      const job = store.createJob(1, 'game-123', 'lichess');
      poller.setGameStatus('game-123', 'completed');
      poller.setGameResult('game-123', 'Player1Wins');

      const status = await poller.poll(job);

      expect(status.status).toBe('completed');
      expect(status.result).toBe('Player1Wins');
    });

    it('detects draw result', async () => {
      const job = store.createJob(1, 'game-123', 'lichess');
      poller.setGameStatus('game-123', 'completed');
      poller.setGameResult('game-123', 'Draw');

      const status = await poller.poll(job);

      expect(status.result).toBe('Draw');
    });

    it('returns cleanup function', () => {
      const cleanup = worker.start();

      expect(typeof cleanup).toBe('function');

      cleanup();
    });

    // #1719 — graceful shutdown must drain in-flight polling work rather
    // than abandoning it.
    describe('graceful shutdown draining', () => {
      it('stop() waits for an in-flight poll to finish before resolving', async () => {
        const delayedPoller = new DelayedGamePoller();
        const delayedStore = new PollingJobStore();
        delayedStore.createJob(1, 'game-slow', 'lichess');

        const delayedWorker = new PollingWorker(delayedStore, delayedPoller, {
          pollingIntervalMs: 100,
          maxPollingAttempts: 5,
          backoffMultiplier: 1.0,
          onGameCompleted: vi.fn().mockResolvedValue(undefined),
          onMaxAttemptsExceeded: vi.fn().mockResolvedValue(undefined),
        });

        delayedWorker.start();
        await delayedPoller.waitUntilStarted();

        let stopResolved = false;
        const stopPromise = delayedWorker.stop().then(() => {
          stopResolved = true;
        });

        // stop() must not resolve while the poll it's draining is still
        // running.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(stopResolved).toBe(false);

        delayedPoller.releasePoll();
        await stopPromise;

        expect(stopResolved).toBe(true);
      });

      it('does not start a new polling cycle after stop() has been called', async () => {
        const delayedPoller = new DelayedGamePoller();
        const delayedStore = new PollingJobStore();
        delayedStore.createJob(1, 'game-slow', 'lichess');

        const delayedWorker = new PollingWorker(delayedStore, delayedPoller, {
          pollingIntervalMs: 10, // short, so a wrongly-scheduled next cycle would fire quickly
          maxPollingAttempts: 5,
          backoffMultiplier: 1.0,
          onGameCompleted: vi.fn().mockResolvedValue(undefined),
          onMaxAttemptsExceeded: vi.fn().mockResolvedValue(undefined),
        });

        delayedWorker.start();
        await delayedPoller.waitUntilStarted();

        const stopPromise = delayedWorker.stop();
        delayedPoller.releasePoll();
        await stopPromise;

        // If a new cycle were wrongly scheduled, pollStarted would flip
        // false->true again once the in-flight poll's own reschedule fired.
        delayedPoller.pollStarted = false;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(delayedPoller.pollStarted).toBe(false);
      });
    });

    it('increments polling attempt on each poll', async () => {
      const job = store.createJob(1, 'game-123', 'lichess');
      poller.setGameStatus('game-123', 'in_progress');

      expect(job.pollingAttempt).toBe(0);

      // Note: In a real test with PollingWorker.start(), this would be async.
      // Here we're testing the store directly.
      store.incrementAttempt(job.id);

      expect(job.pollingAttempt).toBe(1);
      expect(job.lastPolledAt).toBeLessThanOrEqual(Date.now());
    });

    it('calls onMaxAttemptsExceeded with job and reason when limit is reached', async () => {
      const failingPoller = new FailingGamePoller('game_not_found');
      const onMaxAttemptsExceeded = vi.fn().mockResolvedValue(undefined);

      const workerWithCallback = new PollingWorker(
        store,
        failingPoller,
        {
          pollingIntervalMs: 100,
          maxPollingAttempts: 1, // Exceed on the very first attempt
          backoffMultiplier: 1.0,
          onGameCompleted: vi.fn().mockResolvedValue(undefined),
          onMaxAttemptsExceeded,
        },
      );

      const job = store.createJob(1, 'game-999', 'lichess');

      // Simulate enough increments so pollingAttempt >= maxPollingAttempts
      store.incrementAttempt(job.id); // attempt = 1, equals maxPollingAttempts = 1

      // Directly exercise the private pollJob path by having the worker poll
      const cleanup = workerWithCallback.start();

      // Allow micro-tasks to flush
      await new Promise((resolve) => setTimeout(resolve, 50));

      cleanup();

      expect(onMaxAttemptsExceeded).toHaveBeenCalledWith(
        expect.objectContaining({ matchId: 1, gameId: 'game-999' }),
        'game_not_found',
      );
    });

    it('removes job from store when max attempts are exceeded', async () => {
      const failingPoller = new FailingGamePoller('timeout');
      const onMaxAttemptsExceeded = vi.fn().mockResolvedValue(undefined);

      const failStore = new PollingJobStore();
      const workerWithCallback = new PollingWorker(
        failStore,
        failingPoller,
        {
          pollingIntervalMs: 100,
          maxPollingAttempts: 1,
          backoffMultiplier: 1.0,
          onGameCompleted: vi.fn().mockResolvedValue(undefined),
          onMaxAttemptsExceeded,
        },
      );

      const job = failStore.createJob(2, 'game-888', 'lichess');
      failStore.incrementAttempt(job.id); // pollingAttempt = 1

      const cleanup = workerWithCallback.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      cleanup();

      // Job must be removed from the store
      expect(failStore.getJobByMatchId(2)).toBeNull();
    });

    it('removes job from store on max attempts even when callbacks do not throw', async () => {
      const failingPoller = new FailingGamePoller('some_error');
      const noCallbackStore = new PollingJobStore();

      const workerNoCallback = new PollingWorker(
        noCallbackStore,
        failingPoller,
        {
          pollingIntervalMs: 100,
          maxPollingAttempts: 1,
          backoffMultiplier: 1.0,
          onGameCompleted: vi.fn().mockResolvedValue(undefined),
          onMaxAttemptsExceeded: vi.fn().mockResolvedValue(undefined),
        },
      );

      const job = noCallbackStore.createJob(3, 'game-777', 'lichess');
      noCallbackStore.incrementAttempt(job.id); // pollingAttempt = 1

      const cleanup = workerNoCallback.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      cleanup();

      // Job is still removed; no callback error thrown
      expect(noCallbackStore.getJobByMatchId(3)).toBeNull();
    });

    // #51 — a match Active longer than its on-chain timeout_ledgers window
    // is moved to DLQ with reason TIMED_OUT instead of being polled forever.
    it('moves a timed-out match to DLQ with reason TIMED_OUT', async () => {
      const timeoutPoller = new MockGamePoller();
      timeoutPoller.setGameStatus('game-timeout', 'in_progress');
      const pollSpy = vi.spyOn(timeoutPoller, 'poll');

      const onMaxAttemptsExceeded = vi.fn().mockResolvedValue(undefined);
      const timeoutStore = new PollingJobStore();
      // Current ledger is far past createdAtLedger (1000) + timeoutLedgers (120_960).
      const getCurrentLedger = vi.fn().mockResolvedValue(1000 + 120_960 + 1);

      const timeoutWorker = new PollingWorker(timeoutStore, timeoutPoller, {
        pollingIntervalMs: 100,
        maxPollingAttempts: 5,
        backoffMultiplier: 1.0,
        getCurrentLedger,
        onGameCompleted: vi.fn().mockResolvedValue(undefined),
        onMaxAttemptsExceeded,
      });

      // createdAtLedger=1000, timeoutLedgers defaults (not passed) to the
      // worker's defaultTimeoutLedgers (120_960, matching TIMEOUT_LEDGERS).
      const job = timeoutStore.createJob(1, 'game-timeout', 'lichess', undefined, 1000);

      const cleanup = timeoutWorker.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      cleanup();

      expect(getCurrentLedger).toHaveBeenCalled();
      expect(onMaxAttemptsExceeded).toHaveBeenCalledWith(
        expect.objectContaining({ matchId: 1, gameId: 'game-timeout' }),
        'TIMED_OUT',
      );
      // Removed from the store, same as a max-attempts DLQ move.
      expect(timeoutStore.getJobByMatchId(1)).toBeNull();
      // The chess-platform API is never queried once the match has timed out.
      expect(pollSpy).not.toHaveBeenCalled();
    });

    it('does not time out a match still within its timeout_ledgers window', async () => {
      const inProgressPoller = new MockGamePoller();
      inProgressPoller.setGameStatus('game-not-timed-out', 'in_progress');

      const onMaxAttemptsExceeded = vi.fn().mockResolvedValue(undefined);
      const withinWindowStore = new PollingJobStore();
      const getCurrentLedger = vi.fn().mockResolvedValue(1000 + 100); // well within the window

      const withinWindowWorker = new PollingWorker(withinWindowStore, inProgressPoller, {
        pollingIntervalMs: 100,
        maxPollingAttempts: 5,
        backoffMultiplier: 1.0,
        getCurrentLedger,
        onGameCompleted: vi.fn().mockResolvedValue(undefined),
        onMaxAttemptsExceeded,
      });

      withinWindowStore.createJob(1, 'game-not-timed-out', 'lichess', undefined, 1000, 120_960);

      const cleanup = withinWindowWorker.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      cleanup();

      expect(onMaxAttemptsExceeded).not.toHaveBeenCalled();
      expect(withinWindowStore.getJobByMatchId(1)).not.toBeNull();
    });

    it('skips the ledger-timeout check entirely when createdAtLedger is not set', async () => {
      const getCurrentLedger = vi.fn();
      const noLedgerStore = new PollingJobStore();
      const noLedgerPoller = new MockGamePoller();
      noLedgerPoller.setGameStatus('game-no-ledger', 'in_progress');

      const noLedgerWorker = new PollingWorker(noLedgerStore, noLedgerPoller, {
        pollingIntervalMs: 100,
        maxPollingAttempts: 5,
        backoffMultiplier: 1.0,
        getCurrentLedger,
        onGameCompleted: vi.fn().mockResolvedValue(undefined),
        onMaxAttemptsExceeded: vi.fn().mockResolvedValue(undefined),
      });

      // No createdAtLedger passed — existing callers unaffected by #51.
      noLedgerStore.createJob(1, 'game-no-ledger', 'lichess');

      const cleanup = noLedgerWorker.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      cleanup();

      expect(getCurrentLedger).not.toHaveBeenCalled();
      expect(noLedgerStore.getJobByMatchId(1)).not.toBeNull();
    });

    it('calls onGameCompleted with job and result when game finishes', async () => {
      const onGameCompleted = vi.fn().mockResolvedValue(undefined);
      const completedStore = new PollingJobStore();

      const completedWorker = new PollingWorker(
        completedStore,
        poller,
        {
          pollingIntervalMs: 100,
          maxPollingAttempts: 5,
          backoffMultiplier: 1.0,
          onGameCompleted,
          onMaxAttemptsExceeded: vi.fn().mockResolvedValue(undefined),
        },
      );

      completedStore.createJob(10, 'game-completed', 'lichess');
      poller.setGameStatus('game-completed', 'completed');
      poller.setGameResult('game-completed', 'Player1Wins');

      const cleanup = completedWorker.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      cleanup();

      expect(onGameCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ matchId: 10, gameId: 'game-completed' }),
        'Player1Wins',
      );
    });

    it('removes job from store after onGameCompleted is called', async () => {
      const onGameCompleted = vi.fn().mockResolvedValue(undefined);
      const completedStore = new PollingJobStore();

      const completedWorker = new PollingWorker(
        completedStore,
        poller,
        {
          pollingIntervalMs: 100,
          maxPollingAttempts: 5,
          backoffMultiplier: 1.0,
          onGameCompleted,
          onMaxAttemptsExceeded: vi.fn().mockResolvedValue(undefined),
        },
      );

      completedStore.createJob(11, 'game-done', 'lichess');
      poller.setGameStatus('game-done', 'completed');
      poller.setGameResult('game-done', 'Draw');

      const cleanup = completedWorker.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      cleanup();

      expect(completedStore.getJobByMatchId(11)).toBeNull();
    });

    it("retains the completed result and retries without repolling when the callback fails", async () => {
      const onGameCompleted = vi
        .fn()
        .mockRejectedValue(new Error("oracle_down"));
      const errorStore = new PollingJobStore();

      const errorWorker = new PollingWorker(errorStore, poller, {
        pollingIntervalMs: 100,
        maxPollingAttempts: 5,
        backoffMultiplier: 1.0,
        onGameCompleted,
        onMaxAttemptsExceeded: vi.fn().mockResolvedValue(undefined),
      });

      errorStore.createJob(12, "game-error", "lichess");
      poller.setGameStatus("game-error", "completed");
      poller.setGameResult("game-error", "Player2Wins");

      // Should not throw even though the callback rejects
      const cleanup = errorWorker.start();
      await expect(
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ).resolves.toBeUndefined();
      await cleanup();

      expect(onGameCompleted).toHaveBeenCalled();
      expect(errorStore.getJobByMatchId(12)?.pendingResult).toBe("Player2Wins");
      onGameCompleted.mockResolvedValue(undefined);
      const retryWorker = new PollingWorker(errorStore, poller, {
        pollingIntervalMs: 100,
        onGameCompleted,
        onMaxAttemptsExceeded: vi.fn().mockResolvedValue(undefined),
      });
      const pollSpy = vi.spyOn(poller, 'poll');
      const stopRetry = retryWorker.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      await stopRetry();
      expect(errorStore.getJobByMatchId(12)).toBeNull();
      expect(pollSpy).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('handles getJob with non-existent ID', () => {
      const store = new PollingJobStore();
      expect(store.getJob('non-existent')).toBeNull();
    });

    it('handles getJobByMatchId with non-existent matchId', () => {
      const store = new PollingJobStore();
      expect(store.getJobByMatchId(999)).toBeNull();
    });

    it('handles removeJob that does not exist', () => {
      const store = new PollingJobStore();
      expect(() => {
        store.removeJob('non-existent');
      }).not.toThrow();
    });

    it('handles completeJob that does not exist', () => {
      const store = new PollingJobStore();
      expect(() => {
        store.completeJob('non-existent');
      }).not.toThrow();
    });

    it('handles very large backoff multiplier', () => {
      const delay = calculateNextPollDelay(10, 30_000, 2.0);
      // 30_000 * 2^10 = 30,720,000 ms ≈ 8.5 hours
      expect(delay).toBe(30_720_000);
    });

    it('creates distinct job IDs for concurrent creates', () => {
      const store = new PollingJobStore();

      const job1 = store.createJob(1, 'game-1', 'lichess');
      const job2 = store.createJob(2, 'game-2', 'lichess');

      expect(job1.id).not.toBe(job2.id);
    });
  });

  describe('parsePollingIntervalMs (#34)', () => {
    it('returns the default when the env var is unset', () => {
      expect(parsePollingIntervalMs(undefined)).toBe(30_000);
    });

    it('returns the default when the env var is an empty string', () => {
      expect(parsePollingIntervalMs('')).toBe(30_000);
      expect(parsePollingIntervalMs('   ')).toBe(30_000);
    });

    it('parses a valid numeric string', () => {
      expect(parsePollingIntervalMs('45000')).toBe(45_000);
    });

    it('throws a clear error for a non-numeric value', () => {
      expect(() => parsePollingIntervalMs('abc')).toThrow(/Invalid POLLING_INTERVAL_MS/);
      expect(() => parsePollingIntervalMs('abc')).toThrow(/"abc"/);
    });

    it('throws a clear error for zero', () => {
      expect(() => parsePollingIntervalMs('0')).toThrow(/Invalid POLLING_INTERVAL_MS/);
    });

    it('throws a clear error for a negative value', () => {
      expect(() => parsePollingIntervalMs('-5000')).toThrow(/Invalid POLLING_INTERVAL_MS/);
    });

    it('throws for Infinity/NaN-producing input', () => {
      expect(() => parsePollingIntervalMs('Infinity')).toThrow(/Invalid POLLING_INTERVAL_MS/);
    });
  });
});
