/**
 * Provider outages never invent a game outcome (#111).
 *
 * Whatever goes wrong while reading a game (network failure, timeout, 5xx,
 * malformed response, rate limit, missing game) the poller must not report a
 * completed game, and the polling worker must never hand a result to the
 * submission handler, even when the attempt budget runs out.
 * See docs/provider-outage-policy.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ChessPlatformPoller from '../src/services/game-poller.js';
import { PollingJobStore, PollingWorker, type PollJob } from '../src/services/polling.js';

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

import { fetchLichessResult, GameNotFoundError } from '../src/fetchers/lichess.js';
import { fetchChessDotComResult, RateLimitError } from '../src/fetchers/chessdotcom.js';

const mockLichess = vi.mocked(fetchLichessResult);
const mockChess = vi.mocked(fetchChessDotComResult);

function job(overrides: Partial<PollJob> = {}): PollJob {
  return {
    id: 'job-1',
    matchId: 1,
    gameId: 'game-abc',
    platform: 'lichess',
    username: 'alice',
    pollingAttempt: 0,
    createdAt: Date.now(),
    lastPolledAt: null,
    ...overrides,
  };
}

function timeoutError(): Error {
  return Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });
}

const OUTAGES: Array<[string, () => unknown]> = [
  ['connection reset', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  [
    'DNS failure',
    () => Object.assign(new Error('getaddrinfo ENOTFOUND lichess.org'), { code: 'ENOTFOUND' }),
  ],
  ['request timeout', timeoutError],
  ['provider 5xx', () => new Error('Request failed with status code 503')],
  ['unexpected status', () => new Error('Lichess API error: 418')],
  ['malformed body', () => new TypeError("Cannot read properties of undefined (reading 'white')")],
  ['non-Error rejection', () => 'provider exploded'],
  ['game not found', () => new GameNotFoundError('game-abc')],
];

beforeEach(() => vi.clearAllMocks());

describe('ChessPlatformPoller during an outage', () => {
  const poller = new ChessPlatformPoller();

  for (const platform of ['lichess', 'chessdotcom'] as const) {
    const mockFetch = platform === 'lichess' ? mockLichess : mockChess;

    it.each(OUTAGES)(`${platform}: %s is a failed attempt, never a result`, async (_name, make) => {
      mockFetch.mockRejectedValue(make());

      const status = await poller.poll(job({ platform }));

      expect(status.status).toBe('failed');
      expect(status.result).toBeUndefined();
      expect(status.reason).toEqual(expect.any(String));
    });

    it(`${platform}: rate limiting keeps the game in progress, with no result`, async () => {
      mockFetch.mockRejectedValue(new RateLimitError('429'));

      const status = await poller.poll(job({ platform }));

      expect(status).toEqual({ status: 'in_progress', reason: 'Rate limited by API, will retry' });
    });
  }

  it('reports a result only when the platform returned one', async () => {
    mockLichess.mockResolvedValue({
      gameId: 'game-abc',
      status: 'started',
      whitePlayer: 'alice',
      blackPlayer: 'bob',
      result: null,
    });
    expect(await poller.poll(job())).toEqual({ status: 'in_progress' });

    mockLichess.mockResolvedValue({
      gameId: 'game-abc',
      status: 'mate',
      whitePlayer: 'alice',
      blackPlayer: 'bob',
      result: 'Player2Wins',
    });
    expect(await poller.poll(job())).toEqual({ status: 'completed', result: 'Player2Wins' });
  });
});

describe('PollingWorker during a prolonged outage', () => {
  function runWorker(maxPollingAttempts: number) {
    const store = new PollingJobStore();
    const onGameCompleted = vi.fn().mockResolvedValue(undefined);
    const onMaxAttemptsExceeded = vi.fn().mockResolvedValue(undefined);
    const worker = new PollingWorker(store, new ChessPlatformPoller(), {
      pollingIntervalMs: 5,
      maxPollingAttempts,
      backoffMultiplier: 1.0,
      onGameCompleted,
      onMaxAttemptsExceeded,
    });
    return { store, worker, onGameCompleted, onMaxAttemptsExceeded };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('retries, then dead-letters without ever submitting a result', async () => {
    mockLichess.mockRejectedValue(new Error('Request failed with status code 502'));
    const { store, worker, onGameCompleted, onMaxAttemptsExceeded } = runWorker(3);
    store.createJob(7, 'game-outage', 'lichess');

    const stop = worker.start();
    await settle();
    await stop();

    expect(mockLichess.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onGameCompleted).not.toHaveBeenCalled();
    expect(onMaxAttemptsExceeded).toHaveBeenCalledTimes(1);
    expect(onMaxAttemptsExceeded).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 7, gameId: 'game-outage' }),
      'API error: Request failed with status code 502',
    );
    expect(store.getJobByMatchId(7)).toBeNull();
  });

  it('keeps polling through rate limiting and never dead-letters or submits', async () => {
    mockChess.mockRejectedValue(new RateLimitError('429'));
    const { store, worker, onGameCompleted, onMaxAttemptsExceeded } = runWorker(1_000);
    store.createJob(8, 'game-limited', 'chessdotcom', 'alice');

    const stop = worker.start();
    await settle();
    await stop();

    expect(onGameCompleted).not.toHaveBeenCalled();
    expect(onMaxAttemptsExceeded).not.toHaveBeenCalled();
    expect(store.getJobByMatchId(8)).not.toBeNull();
  });

  it('settles normally once the provider recovers', async () => {
    mockLichess
      .mockRejectedValueOnce(timeoutError())
      .mockRejectedValueOnce(new Error('Request failed with status code 503'))
      .mockResolvedValue({
        gameId: 'game-recovers',
        status: 'resign',
        whitePlayer: 'alice',
        blackPlayer: 'bob',
        result: 'Player1Wins',
      });
    const { store, worker, onGameCompleted, onMaxAttemptsExceeded } = runWorker(10);
    store.createJob(9, 'game-recovers', 'lichess');

    const stop = worker.start();
    await settle();
    await stop();

    expect(onMaxAttemptsExceeded).not.toHaveBeenCalled();
    expect(onGameCompleted).toHaveBeenCalledTimes(1);
    expect(onGameCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 9 }),
      'Player1Wins',
    );
  });
});
