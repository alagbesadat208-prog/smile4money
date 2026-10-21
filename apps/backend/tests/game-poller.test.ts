import { providerMetadata } from './helpers/provider-metadata.js';
/**
 * Unit tests for ChessPlatformPoller (#1721): the fetcher used to poll a job
 * must be selected by `job.platform`, never inferred from the gameId's
 * format, and an unrecognized platform must fail the job immediately with a
 * descriptive reason rather than silently guessing a fetcher.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ChessPlatformPoller from '../src/services/game-poller.js';
import type { PollJob } from '../src/services/polling.js';

vi.mock('../src/fetchers/lichess.js', () => ({
  fetchLichessResult: vi.fn(),
  GameNotFoundError: class GameNotFoundError extends Error {
    constructor(gameId: string) {
      super(`Lichess game not found: ${gameId}`);
      this.name = 'GameNotFoundError';
    }
  },
}));

vi.mock('../src/fetchers/chessdotcom.js', () => ({
  fetchChessDotComResult: vi.fn(),
  RateLimitError: class RateLimitError extends Error {},
}));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { fetchLichessResult } from '../src/fetchers/lichess.js';
import { fetchChessDotComResult } from '../src/fetchers/chessdotcom.js';

const mockFetchLichess = vi.mocked(fetchLichessResult);
const mockFetchChess = vi.mocked(fetchChessDotComResult);

function makeJob(overrides: Partial<PollJob> = {}): PollJob {
  return {
    id: 'job-1',
    matchId: 1,
    gameId: 'game-abc',
    platform: 'lichess',
    pollingAttempt: 0,
    createdAt: Date.now(),
    lastPolledAt: null,
    ...overrides,
  };
}

describe('ChessPlatformPoller platform selection (#1721)', () => {
  let poller: ChessPlatformPoller;

  beforeEach(() => {
    vi.clearAllMocks();
    poller = new ChessPlatformPoller();
  });

  it('polls only the lichess fetcher for a job whose platform is lichess, regardless of gameId shape', async () => {
    // A gameId that looks like it could belong to either platform must not
    // influence fetcher selection — only job.platform does.
    const job = makeJob({ platform: 'lichess', gameId: 'abcdefgh12345678' });
    mockFetchLichess.mockResolvedValue({
      gameId: job.gameId,
      ...providerMetadata(),
      status: 'finished',
      whitePlayer: 'alice',
      blackPlayer: 'bob',
      result: 'Player1Wins',
    });

    const status = await poller.poll(job);

    expect(status.status).toBe('completed');
    expect(mockFetchLichess).toHaveBeenCalledWith('abcdefgh12345678');
    expect(mockFetchChess).not.toHaveBeenCalled();
  });

  it('polls only the chessdotcom fetcher for a job whose platform is chessdotcom', async () => {
    const job = makeJob({ platform: 'chessdotcom', gameId: '123456789', username: 'alice' });
    mockFetchChess.mockResolvedValue({
      gameId: job.gameId,
      ...providerMetadata(),
      status: 'finished',
      whitePlayer: 'alice',
      blackPlayer: 'bob',
      result: 'Player1Wins',
    });

    const status = await poller.poll(job);

    expect(status.status).toBe('completed');
    expect(mockFetchChess).toHaveBeenCalledWith('alice', '123456789');
    expect(mockFetchLichess).not.toHaveBeenCalled();
  });

  it('fails immediately with a descriptive reason for an unrecognized platform, without calling either fetcher', async () => {
    const job = makeJob({ platform: 'unknown-platform' as PollJob['platform'] });

    const status = await poller.poll(job);

    expect(status.status).toBe('failed');
    expect(status.reason).toContain('Unknown platform');
    expect(status.reason).toContain('unknown-platform');
    expect(mockFetchLichess).not.toHaveBeenCalled();
    expect(mockFetchChess).not.toHaveBeenCalled();
  });

  it('fails immediately when platform is chessdotcom but username is missing', async () => {
    const job = makeJob({ platform: 'chessdotcom', username: undefined });

    const status = await poller.poll(job);

    expect(status.status).toBe('failed');
    expect(status.reason).toContain('username');
    expect(mockFetchChess).not.toHaveBeenCalled();
  });
});
