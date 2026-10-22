import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { fetchLichessResult } from '../../src/fetchers/lichess.js';
import { fetchChessDotComResult } from '../../src/fetchers/chessdotcom.js';
import {
  ProviderFetchError,
  CLOCK_SKEW_MS,
  MAX_LIVE_DURATION_MS,
} from '../../src/fetchers/provider-validation.js';
import { ChessPlatformPoller } from '../../src/services/game-poller.js';
import {
  verifyGameResult,
  validateSubmitResultInput,
} from '../../src/services/oracle-service.js';
import { SqliteMatchStore } from '../../src/store/sqlite-match-store.js';
import { MatchStore } from '../../src/store/match-store.js';
import logger from '../../src/logger.js';

vi.mock('axios');
vi.mock('../../src/services/bottleneck-limiters.js', () => ({
  getChessDotComLimiterSingleton: () => ({
    schedule: (fn: () => Promise<unknown>) => fn(),
  }),
}));
vi.mock('../../src/logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
const get = vi.mocked(axios.get);
const now = Date.now();
const lichess = {
  id: 'game',
  status: 'mate',
  winner: 'white',
  createdAt: now - 60_000,
  lastMoveAt: now,
  players: {
    white: { user: { name: 'alice' } },
    black: { user: { name: 'bob' } },
  },
};
const chess = {
  url: 'https://www.chess.com/game/live/game',
  start_time: Math.floor((now - 60_000) / 1000),
  end_time: Math.floor(now / 1000),
  white: { username: 'alice', result: 'win' },
  black: { username: 'bob', result: 'resigned' },
};
const payload = {
  player1: 'p1',
  player2: 'p2',
  player1Username: 'alice',
  player2Username: 'bob',
  gameId: 'game',
  platform: 'lichess',
  token: 'XLM',
  stakeAmount: 1,
};
const job = {
  id: 'job',
  matchId: 0,
  gameId: 'game',
  platform: 'lichess' as const,
  pollingAttempt: 0,
  createdAt: now,
  lastPolledAt: null,
};
beforeEach(() => {
  vi.clearAllMocks();
});

for (const platform of ['lichess', 'chessdotcom'] as const) {
  const fetch = () =>
    platform === 'lichess'
      ? fetchLichessResult('game')
      : fetchChessDotComResult('alice', 'game');
  const respond = (game: unknown) =>
    get.mockResolvedValue({
      status: 200,
      data: platform === 'lichess' ? game : { games: [game] },
    });
  describe(`${platform} evidence boundary`, () => {
    it.each([503, 408])('retries HTTP %s', async (status) => {
      get.mockResolvedValue({ status });
      await expect(fetch()).rejects.toMatchObject({
        kind: 'unavailable',
        policy: 'retry',
      });
    });
    it('retries transport failures with a redacted message', async () => {
      get.mockRejectedValue(new Error('secret token and response'));
      await expect(fetch()).rejects.toMatchObject({
        policy: 'retry',
        message: 'Provider unavailable; retry later',
      });
    });
    it('sends access failures for review', async () => {
      get.mockResolvedValue({ status: 403 });
      await expect(fetch()).rejects.toMatchObject({
        kind: 'access_denied',
        policy: 'review',
      });
    });
    it('quarantines malformed data', async () => {
      get.mockResolvedValue({ status: 200, data: {} });
      await expect(fetch()).rejects.toMatchObject({
        kind: 'invalid_data',
        policy: 'review',
      });
    });
    it.each(['reversed', 'future', 'duration', 'missing', 'noninteger'])(
      'quarantines %s chronology before settlement',
      async (kind) => {
        let start = now - 60_000;
        let end = now;
        if (kind === 'reversed') start = end + 1_000;
        if (kind === 'future') end = now + CLOCK_SKEW_MS + 10_000;
        if (kind === 'duration') start = end - MAX_LIVE_DURATION_MS - 1_000;
        const game =
          platform === 'lichess'
            ? {
                ...lichess,
                createdAt: kind === 'missing' ? undefined : start,
                lastMoveAt: kind === 'noninteger' ? end + 0.5 : end,
              }
            : {
                ...chess,
                start_time: kind === 'missing' ? undefined : start / 1000,
                end_time:
                  kind === 'noninteger' ? (end + 0.5) / 1000 : end / 1000,
              };
        respond(game);
        await expect(fetch()).rejects.toBeInstanceOf(ProviderFetchError);
        const store = new MatchStore();
        await store.createMatch({ ...payload, platform });
        const verified = await verifyGameResult(store, {
          matchId: 0,
          gameId: 'game',
          platform,
          username: 'alice',
        });
        expect(verified).toMatchObject({
          ok: false,
          status: 422,
          hint: 'operator_review',
        });
        const polled = await new ChessPlatformPoller().poll({
          ...job,
          platform,
          username: 'alice',
        });
        expect(polled).toMatchObject({ status: 'failed', action: 'review' });
        expect(polled).not.toHaveProperty('result');
      },
    );
    it('accepts chronology inside the skew allowance', async () => {
      respond(
        platform === 'lichess'
          ? { ...lichess, lastMoveAt: now + 10_000 }
          : { ...chess, end_time: Math.floor(now / 1000) + 10 },
      );
      await expect(fetch()).resolves.toMatchObject({ result: 'Player1Wins' });
    });
  });
}

describe('Chess.com terminal mapping', () => {
  it.each([
    'checkmated',
    'resigned',
    'timeout',
    'lose',
    'abandoned',
    'kingofthehill',
    'threecheck',
    'bughousepartnerlose',
  ])('maps win/%s in both colors', async (loss) => {
    for (const reverse of [false, true]) {
      get.mockResolvedValue({
        status: 200,
        data: {
          games: [
            {
              ...chess,
              white: { username: 'alice', result: reverse ? loss : 'win' },
              black: { username: 'bob', result: reverse ? 'win' : loss },
            },
          ],
        },
      });
      await expect(
        fetchChessDotComResult('alice', 'game'),
      ).resolves.toMatchObject({
        result: reverse ? 'Player2Wins' : 'Player1Wins',
      });
    }
  });
  it.each([
    'agreed',
    'stalemate',
    'repetition',
    'insufficient',
    'timevsinsufficient',
    '50move',
  ])('maps %s draws', async (code) => {
    get.mockResolvedValue({
      status: 200,
      data: {
        games: [
          {
            ...chess,
            white: { username: 'alice', result: code },
            black: { username: 'bob', result: code },
          },
        ],
      },
    });
    await expect(
      fetchChessDotComResult('alice', 'game'),
    ).resolves.toMatchObject({ result: 'Draw' });
  });
  it.each([
    ['win', 'secret-new-code'],
    ['secret-new-code', 'stalemate'],
    ['win', 'win'],
    ['resigned', 'timeout'],
  ])('quarantines conflicting or unknown codes %s/%s', async (white, black) => {
    get.mockResolvedValue({
      status: 200,
      data: {
        games: [
          {
            ...chess,
            white: { username: 'alice', result: white },
            black: { username: 'bob', result: black },
          },
        ],
      },
    });
    await expect(fetchChessDotComResult('alice', 'game')).rejects.toMatchObject(
      { policy: 'review' },
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toMatch(
      /secret-new-code|alice|bob/,
    );
  });
  it('reads live start time from PGN', async () => {
    get.mockResolvedValue({
      status: 200,
      data: {
        games: [
          {
            ...chess,
            start_time: undefined,
            pgn: '[UTCDate "2023.11.14"]\n[UTCTime "22:13:20"]',
            end_time: 1700000060,
          },
        ],
      },
    });
    await expect(
      fetchChessDotComResult('alice', 'game'),
    ).resolves.toMatchObject({ result: 'Player1Wins' });
  });
});

describe('match identifier boundaries', () => {
  it.each([0, 1, Number.MAX_SAFE_INTEGER])('accepts %s', (id) => {
    expect(
      validateSubmitResultInput({
        matchId: id,
        gameId: 'game',
        platform: 'lichess',
      }),
    ).toBeNull();
  });
  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s',
    (id) => {
      expect(
        validateSubmitResultInput({
          matchId: id,
          gameId: 'game',
          platform: 'lichess',
        }),
      ).not.toBeNull();
    },
  );
  it('verifies the first stored match with identifier zero', async () => {
    const store = new MatchStore();
    const match = await store.createMatch(payload);
    expect(match.matchId).toBe(0);
    get.mockResolvedValue({ status: 200, data: lichess });
    await expect(
      verifyGameResult(store, {
        matchId: 0,
        gameId: 'game',
        platform: 'lichess',
      }),
    ).resolves.toMatchObject({ ok: true, matchId: 0 });
  });
});

describe('poller failure policies', () => {
  it('retries provider outages without a settlement result', async () => {
    get.mockResolvedValue({ status: 503 });
    await expect(new ChessPlatformPoller().poll(job)).resolves.toMatchObject({
      status: 'failed',
      action: 'retry',
    });
  });
  it('stops polling a genuinely missing game', async () => {
    get.mockResolvedValue({ status: 404 });
    await expect(new ChessPlatformPoller().poll(job)).resolves.toMatchObject({
      status: 'failed',
      action: 'stop',
    });
  });
  it('retries Chess.com rate limits', async () => {
    get.mockResolvedValue({ status: 429 });
    await expect(
      new ChessPlatformPoller().poll({
        ...job,
        platform: 'chessdotcom',
        username: 'alice',
      }),
    ).resolves.toMatchObject({ status: 'in_progress' });
  });
});

describe('store allocation range', () => {
  it('allocates the maximum safe identifier once, then refuses overflow', async () => {
    const store = new MatchStore();
    // Place the allocator at the boundary without allocating quadrillions of records.
    (store as unknown as { nextId: number }).nextId = Number.MAX_SAFE_INTEGER;
    await expect(store.createMatch(payload)).resolves.toMatchObject({
      matchId: Number.MAX_SAFE_INTEGER,
    });
    await expect(
      store.createMatch({ ...payload, gameId: 'next' }),
    ).rejects.toThrow('range exhausted');
    expect(await store.count()).toBe(1);
  });
});

describe('SQLite identifier compatibility', () => {
  it('allocates zero, one and the maximum safe identifier, then refuses overflow', async () => {
    const store = new SqliteMatchStore(':memory:');
    await store.initialize();
    try {
      await expect(store.createMatch(payload)).resolves.toMatchObject({
        matchId: 0,
      });
      await expect(
        store.createMatch({ ...payload, gameId: 'one' }),
      ).resolves.toMatchObject({ matchId: 1 });
      (store as unknown as { nextId: number }).nextId = Number.MAX_SAFE_INTEGER;
      await expect(
        store.createMatch({ ...payload, gameId: 'max' }),
      ).resolves.toMatchObject({ matchId: Number.MAX_SAFE_INTEGER });
      await expect(store.findByGameId('max')).resolves.toMatchObject({
        matchId: Number.MAX_SAFE_INTEGER,
      });
      await expect(
        store.createMatch({ ...payload, gameId: 'overflow' }),
      ).rejects.toThrow('range exhausted');
    } finally {
      await store.close();
    }
  });
});

describe('malformed player records', () => {
  it('quarantines Lichess players without usernames', async () => {
    get.mockResolvedValue({
      status: 200,
      data: { ...lichess, players: { white: {}, black: {} } },
    });
    await expect(fetchLichessResult('game')).rejects.toMatchObject({
      kind: 'invalid_data',
      policy: 'review',
    });
  });
  it('quarantines empty Chess.com usernames', async () => {
    get.mockResolvedValue({
      status: 200,
      data: { games: [{ ...chess, white: { username: '', result: 'win' } }] },
    });
    await expect(fetchChessDotComResult('alice', 'game')).rejects.toMatchObject(
      { kind: 'invalid_data', policy: 'review' },
    );
  });
});
