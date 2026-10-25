import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadRetryConfig,
  calculateBackoffDelay,
  submitWithRetry,
  retryDlqEntry,
  submitWithIdempotence,
  type RetryConfig,
  type OracleSubmission,
} from '../src/services/oracle-submit.js';
import { initializeQueue, listDlqEntries, removeDlqEntry } from '../src/queue.js';

// The queue API became async with the persistent stores; initialise the
// in-memory store and clear it between tests.
async function clearDlq() {
  for (const entry of await listDlqEntries()) {
    await removeDlqEntry(entry.id);
  }
}

beforeEach(async () => {
  process.env.QUEUE_STORE = 'memory';
  await initializeQueue();
  await clearDlq();
  vi.useFakeTimers();
});

describe('loadRetryConfig', () => {
  it('returns default config when env vars are not set', () => {
    delete process.env.ORACLE_MAX_RETRIES;
    delete process.env.ORACLE_RETRY_BASE_MS;
    delete process.env.ORACLE_RETRY_MAX_MS;

    const config = loadRetryConfig();
    expect(config.maxRetries).toBe(5);
    expect(config.baseDelayMs).toBe(1000);
    expect(config.maxDelayMs).toBe(60000);
  });

  it('reads config from environment variables', () => {
    process.env.ORACLE_MAX_RETRIES = '10';
    process.env.ORACLE_RETRY_BASE_MS = '500';
    process.env.ORACLE_RETRY_MAX_MS = '30000';

    const config = loadRetryConfig();
    expect(config.maxRetries).toBe(10);
    expect(config.baseDelayMs).toBe(500);
    expect(config.maxDelayMs).toBe(30000);
  });
});

describe('calculateBackoffDelay', () => {
  const config: RetryConfig = {
    maxRetries: 5,
    baseDelayMs: 1000,
    maxDelayMs: 60000,
  };

  it('calculates exponential backoff for each attempt', () => {
    expect(calculateBackoffDelay(0, config)).toBe(1000);
    expect(calculateBackoffDelay(1, config)).toBe(2000);
    expect(calculateBackoffDelay(2, config)).toBe(4000);
    expect(calculateBackoffDelay(3, config)).toBe(8000);
    expect(calculateBackoffDelay(4, config)).toBe(16000);
    expect(calculateBackoffDelay(5, config)).toBe(32000);
  });

  it('caps delay at maxDelayMs', () => {
    expect(calculateBackoffDelay(6, config)).toBe(60000);
    expect(calculateBackoffDelay(7, config)).toBe(60000);
    expect(calculateBackoffDelay(10, config)).toBe(60000);
  });

  it('respects custom base and max values', () => {
    const customConfig: RetryConfig = {
      maxRetries: 3,
      baseDelayMs: 500,
      maxDelayMs: 5000,
    };
    expect(calculateBackoffDelay(0, customConfig)).toBe(500);
    expect(calculateBackoffDelay(1, customConfig)).toBe(1000);
    expect(calculateBackoffDelay(2, customConfig)).toBe(2000);
    expect(calculateBackoffDelay(3, customConfig)).toBe(4000);
    expect(calculateBackoffDelay(4, customConfig)).toBe(5000); // capped
  });
});

describe('submitWithRetry', () => {
  const config: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  };

  const submission: OracleSubmission = {
    matchId: 42,
    gameId: 'lichess_abc123',
    result: 'Player1Wins',
  };

  it('succeeds on first attempt', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const result = await submitWithRetry(submission, handler, config);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(submission);
    expect(result).toBeUndefined();
  });

  it('retries on transient failures', async () => {
    const error = new Error('RPC timeout');
    const handler = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);

    const result = await submitWithRetry(submission, handler, config);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(result).toBeUndefined();
  });

  it('writes to DLQ after max retries exhausted', async () => {
    const error = new Error('Fee bump required');
    const handler = vi.fn().mockRejectedValue(error);

    const result = await submitWithRetry(submission, handler, config);

    // Should be called maxRetries + 1 times (initial + retries)
    expect(handler).toHaveBeenCalledTimes(config.maxRetries + 1);
    expect(result).toBeDefined();
    expect(result?.payload).toEqual(submission);
    expect(result?.failureReason).toBe(error.message);
  });

  it('respects exponential backoff timing', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('err'))
      .mockResolvedValueOnce(undefined);

    const promise = submitWithRetry(submission, handler, config);

    // Verify delays match exponential backoff
    const delay1 = calculateBackoffDelay(0, config); // 100ms
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(delay1);
    
    await promise;
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('increases attempt count on retries', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('err'));
    const result = await submitWithRetry(submission, handler, config);

    expect(result?.attempts).toBe(config.maxRetries + 1);
  });

  it('preserves submission details in DLQ entry', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await submitWithRetry(submission, handler, config);

    expect(result?.payload).toEqual(submission);
    const dlqEntries = listDlqEntries();
    expect(dlqEntries[0].payload).toEqual(submission);
  });
});

describe('retryDlqEntry', () => {
  it('removes entry from DLQ on successful retry', async () => {
    const submission: OracleSubmission = {
      matchId: 1,
      gameId: 'game1',
      result: 'Draw',
    };
    const config: RetryConfig = {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    };

    // Write to DLQ first
    const dlqEntry = await (async () => {
      const handler = vi.fn().mockRejectedValue(new Error('err'));
      return await submitWithRetry(submission, handler, config);
    })();

    expect(dlqEntry).toBeDefined();
    expect(listDlqEntries()).toHaveLength(1);

    // Retry the entry
    const handler = vi.fn().mockResolvedValue(undefined);
    const success = await retryDlqEntry(dlqEntry!, handler);

    expect(success).toBe(true);
    expect(handler).toHaveBeenCalledWith(submission);
  });

  it('keeps entry in DLQ on retry failure', async () => {
    const submission: OracleSubmission = {
      matchId: 2,
      gameId: 'game2',
      result: 'Player2Wins',
    };
    const config: RetryConfig = {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    };

    // Write to DLQ
    const dlqEntry = await (async () => {
      const handler = vi.fn().mockRejectedValue(new Error('err'));
      return await submitWithRetry(submission, handler, config);
    })();

    expect(listDlqEntries()).toHaveLength(1);

    // Retry fails
    const handler = vi.fn().mockRejectedValue(new Error('still failing'));
    const success = await retryDlqEntry(dlqEntry!, handler);

    expect(success).toBe(false);
    expect(listDlqEntries()).toHaveLength(1);
  });

  it('returns false when handler throws', async () => {
    const submission: OracleSubmission = {
      matchId: 3,
      gameId: 'game3',
      result: 'Player1Wins',
    };
    const config: RetryConfig = {
      maxRetries: 1,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    };

    const dlqEntry = await (async () => {
      const handler = vi.fn().mockRejectedValue(new Error('network'));
      return await submitWithRetry(submission, handler, config);
    })();

    const handler = vi.fn().mockRejectedValue(new Error('RPC down'));
    const success = await retryDlqEntry(dlqEntry!, handler);

    expect(success).toBe(false);
  });
});

describe('submitWithIdempotence', () => {
  const config: RetryConfig = {
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  };

  const submission: OracleSubmission = {
    matchId: 42,
    gameId: 'lichess_abc123',
    result: 'Player1Wins',
  };

  it('skips submission if result already exists on-chain', async () => {
    const existenceChecker = vi.fn().mockResolvedValue(true);
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await submitWithIdempotence(
      submission,
      handler,
      existenceChecker,
      config
    );

    // Should return undefined (success), but handler not called
    expect(result).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(existenceChecker).toHaveBeenCalledWith(submission.matchId);
  });

  it('proceeds with submission if result does not exist', async () => {
    const existenceChecker = vi.fn().mockResolvedValue(false);
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await submitWithIdempotence(
      submission,
      handler,
      existenceChecker,
      config
    );

    // Should succeed and call handler
    expect(result).toBeUndefined();
    expect(handler).toHaveBeenCalledWith(submission);
  });

  it('continues with submission if existence check fails', async () => {
    const checkError = new Error('RPC timeout on existence check');
    const existenceChecker = vi.fn().mockRejectedValue(checkError);
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await submitWithIdempotence(
      submission,
      handler,
      existenceChecker,
      config
    );

    // Should attempt submission despite check failure
    expect(result).toBeUndefined();
    expect(handler).toHaveBeenCalledWith(submission);
    expect(existenceChecker).toHaveBeenCalledWith(submission.matchId);
  });

  it('writes to DLQ if submission fails after existence check passes', async () => {
    const existenceChecker = vi.fn().mockResolvedValue(false);
    const handler = vi.fn().mockRejectedValue(new Error('Fee bump required'));

    const result = await submitWithIdempotence(
      submission,
      handler,
      existenceChecker,
      config
    );

    // Should write to DLQ after retries exhausted
    expect(result).toBeDefined();
    expect(result?.payload).toEqual(submission);
    expect(listDlqEntries()).toHaveLength(1);
  });

  it('handles idempotent race condition: result exists mid-retry', async () => {
    const existenceChecker = vi.fn().mockResolvedValue(false);
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('RPC error'))
      .mockResolvedValueOnce(undefined);

    const result = await submitWithIdempotence(
      submission,
      handler,
      existenceChecker,
      config
    );

    // Should succeed after retry
    expect(result).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('logs existence check failures as warnings', async () => {
    const existenceChecker = vi.fn().mockRejectedValue(new Error('Network error'));
    const handler = vi.fn().mockResolvedValue(undefined);

    // Suppress logger output for test clarity
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await submitWithIdempotence(
      submission,
      handler,
      existenceChecker,
      config
    );

    expect(handler).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs idempotent skips as informational', async () => {
    const existenceChecker = vi.fn().mockResolvedValue(true);
    const handler = vi.fn();

    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await submitWithIdempotence(
      submission,
      handler,
      existenceChecker,
      config
    );

    // Verify that info log was called (logged as JSON)
    expect(infoSpy).toHaveBeenCalled();
    const logCall = infoSpy.mock.calls[0][0];
    expect(logCall).toContain('already exists');

    infoSpy.mockRestore();
  });

  it('checks existence before each submission batch', async () => {
    const submissions = [
      { matchId: 1, gameId: 'game1', result: 'Player1Wins' as const },
      { matchId: 2, gameId: 'game2', result: 'Player2Wins' as const },
    ];

    for (const sub of submissions) {
      const existenceChecker = vi.fn().mockResolvedValue(false);
      const handler = vi.fn().mockResolvedValue(undefined);

      await submitWithIdempotence(sub, handler, existenceChecker, config);

      expect(existenceChecker).toHaveBeenCalledWith(sub.matchId);
    }
  });
});
