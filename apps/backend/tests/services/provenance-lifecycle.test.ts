import { expect, it, vi } from 'vitest';
import {
  submitWithRetry,
  retryDlqEntry,
} from '../../src/services/oracle-submit.js';
import { writeToDlq } from '../../src/queue.js';
vi.mock('../../src/queue.js', () => ({
  writeToDlq: vi.fn(async (payload) => ({ id: 'dlq', payload, attempts: 1 })),
}));
it('retains the durable decision reference through failure, DLQ and successful retry', async () => {
  const submission = {
    matchId: 1,
    gameId: 'game',
    result: 'Player1Wins' as const,
    decisionId: 12,
  };
  const failed = vi.fn().mockRejectedValue(new Error('RPC unavailable'));
  const entry = await submitWithRetry(submission, failed, {
    maxRetries: 0,
    baseDelayMs: 1,
    maxDelayMs: 1,
  });
  expect(writeToDlq).toHaveBeenCalledWith(submission, 'RPC unavailable');
  expect(entry?.payload).toMatchObject({ decisionId: 12 });
  const successful = vi.fn().mockResolvedValue(undefined);
  expect(await retryDlqEntry(entry!, successful)).toBe(true);
  expect(successful).toHaveBeenCalledWith(submission);
});
