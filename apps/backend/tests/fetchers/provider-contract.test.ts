import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  fetchChessDotComResult,
  parseArchiveMonths,
  GameNotFoundError,
} from '../../src/fetchers/chessdotcom.js';
import { fetchLichessResult } from '../../src/fetchers/lichess.js';
import { AmbiguousEvidenceError } from '../../src/fetchers/result.js';
vi.mock('axios');
vi.mock('../../src/services/bottleneck-limiters.js', () => ({
  getChessDotComLimiterSingleton: () => ({
    schedule: (f: () => unknown) => f(),
  }),
}));
const get = vi.mocked(axios.get);
const chess = {
  url: 'https://www.chess.com/game/live/42',
  end_time: 1700000000,
  white: { username: 'alice', result: 'win' },
  black: { username: 'bob', result: 'resigned' },
};
const lichess = {
  id: '42',
  status: 'mate',
  lastMoveAt: 1700000000000,
  winner: 'white',
  players: {
    white: { user: { name: 'alice' } },
    black: { user: { name: 'bob' } },
  },
};
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe('provider boundary contract', () => {
  it('normalizes both providers to identical UTC time, outcome and status with minimal provenance', async () => {
    get
      .mockResolvedValueOnce({ status: 200, data: lichess })
      .mockResolvedValueOnce({ status: 200, data: { games: [chess] } });
    const a = await fetchLichessResult('42');
    const b = await fetchChessDotComResult('alice', '42');
    for (const value of [a, b]) {
      expect(value).toMatchObject({
        status: 'finished',
        result: 'Player1Wins',
        endedAt: '2023-11-14T22:13:20.000Z',
      });
      expect(value.evidence).toMatchObject({
        parserVersion: '2',
        outcome: 'Player1Wins',
        responseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        fetchedAt: expect.stringMatching(/Z$/),
      });
      expect(JSON.stringify(value.evidence)).not.toMatch(
        /alice|bob|players|pgn/,
      );
    }
  });
  it.each(['win', 'mystery', 'resigned'])(
    'quarantines conflicting Chess.com outcomes: win / %s',
    async (black) => {
      get.mockResolvedValue({
        status: 200,
        data: {
          games: [{ ...chess, black: { ...chess.black, result: black } }],
        },
      });
      if (black === 'resigned')
        return expect(
          (await fetchChessDotComResult('alice', '42')).result,
        ).toBe('Player1Wins');
      await expect(
        fetchChessDotComResult('alice', '42'),
      ).rejects.toBeInstanceOf(AmbiguousEvidenceError);
    },
  );
  it.each([
    { status: 'unknownFinish' },
    { winner: undefined },
    { lastMoveAt: 'invalid' },
    { status: 'draw', winner: 'white' },
    { status: 'started', winner: 'white' },
    { players: {} },
    { id: 'other' },
  ])(
    'quarantines incomplete or contradictory Lichess evidence %j',
    async (patch) => {
      get.mockResolvedValue({ status: 200, data: { ...lichess, ...patch } });
      await expect(fetchLichessResult('42')).rejects.toBeInstanceOf(
        AmbiguousEvidenceError,
      );
    },
  );
  it('handles malformed archives as ambiguous evidence', async () => {
    get.mockResolvedValue({ status: 200, data: {} });
    await expect(fetchChessDotComResult('alice', '42')).rejects.toBeInstanceOf(
      AmbiguousEvidenceError,
    );
  });
  it('finds the oldest configured month beyond a year using UTC year rollover', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:30:00Z'));
    vi.stubEnv('CHESSDOTCOM_ARCHIVE_MONTHS', '25');
    get.mockImplementation(async (url) => ({
      status: 200,
      data: { games: String(url).endsWith('/2024/01') ? [chess] : [] },
    }));
    expect((await fetchChessDotComResult('alice', '42')).result).toBe(
      'Player1Wins',
    );
    expect(get).toHaveBeenCalledTimes(25);
    expect(get.mock.calls[24][0]).toMatch(/\/2024\/01$/);
  });
  it('stops exactly at the configured bound for a true not-found result', async () => {
    vi.stubEnv('CHESSDOTCOM_ARCHIVE_MONTHS', '25');
    get.mockResolvedValue({ status: 404, data: {} });
    await expect(
      fetchChessDotComResult('alice', 'missing'),
    ).rejects.toBeInstanceOf(GameNotFoundError);
    expect(get).toHaveBeenCalledTimes(25);
  });
  it.each(['0', '-1', '601', '1.5', 'NaN', ''])(
    'rejects invalid archive limits %s before fetching',
    async (raw) => {
      vi.stubEnv('CHESSDOTCOM_ARCHIVE_MONTHS', raw);
      await expect(fetchChessDotComResult('alice', '42')).rejects.toThrow(
        'CHESSDOTCOM_ARCHIVE_MONTHS',
      );
      expect(get).not.toHaveBeenCalled();
    },
  );
  it('uses a bounded ten-year default', () => {
    expect(parseArchiveMonths()).toBe(120);
  });
  it('supports the maximum configured range of 600 months', async () => {
    vi.stubEnv('CHESSDOTCOM_ARCHIVE_MONTHS', '600');
    let count = 0;
    get.mockImplementation(async () => ({
      status: 200,
      data: { games: ++count === 600 ? [chess] : [] },
    }));
    expect((await fetchChessDotComResult('alice', '42')).result).toBe(
      'Player1Wins',
    );
    expect(get).toHaveBeenCalledTimes(600);
  });
});
