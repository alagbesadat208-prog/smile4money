import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { fetchLichessResult, GameNotFoundError } from '../../src/fetchers/lichess.js';
import { RateLimitError } from '../../src/errors/RateLimitError.js';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

const BASE_GAME = {
  id: 'abc123',
  lastMoveAt: 1700000000000,
  status: 'mate',
  players: {
    white: { user: { name: 'alice' } },
    black: { user: { name: 'bob' } },
  },
};

beforeEach(() => { vi.clearAllMocks(); });

describe('fetchLichessResult', () => {
  it('returns Player1Wins when white wins', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { ...BASE_GAME, winner: 'white' },
    });

    const result = await fetchLichessResult('abc123');
    expect(result.result).toBe('Player1Wins');
    expect(result.whitePlayer).toBe('alice');
    expect(result.blackPlayer).toBe('bob');
  });

  it('returns Player2Wins when black wins', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { ...BASE_GAME, winner: 'black' },
    });

    const result = await fetchLichessResult('abc123');
    expect(result.result).toBe('Player2Wins');
  });

  it('returns Draw when no winner on terminal status', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { ...BASE_GAME, status: 'draw' },
    });

    const result = await fetchLichessResult('abc123');
    expect(result.result).toBe('Draw');
  });

  it('returns null result for in-progress game', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { ...BASE_GAME, status: 'started', winner: undefined },
    });

    const result = await fetchLichessResult('abc123');
    expect(result.result).toBeNull();
  });

  it('throws GameNotFoundError on 404', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({ status: 404, data: {} });

    await expect(fetchLichessResult('missing')).rejects.toThrow(GameNotFoundError);
  });

  it('throws on an unexpected HTTP error status', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({ status: 503, data: {} });

    await expect(fetchLichessResult('abc123')).rejects.toThrow('Lichess API error: 503');
  });

  describe('HTTP 429 rate limiting (#33)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits the Retry-After duration (seconds) before retrying, then succeeds', async () => {
      mockedAxios.get = vi
        .fn()
        .mockResolvedValueOnce({ status: 429, data: {}, headers: { 'retry-after': '5' } })
        .mockResolvedValueOnce({ status: 200, data: { ...BASE_GAME, winner: 'white' } });

      const promise = fetchLichessResult('abc123');

      // Only one call so far -- the retry must not fire before the delay elapses.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Just under 5s: still must not have retried yet.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // At 5s the retry fires.
      await vi.advanceTimersByTimeAsync(1);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);

      const result = await promise;
      expect(result.result).toBe('Player1Wins');
    });

    it('uses a safe default delay when Retry-After is absent', async () => {
      mockedAxios.get = vi
        .fn()
        .mockResolvedValueOnce({ status: 429, data: {}, headers: {} })
        .mockResolvedValueOnce({ status: 200, data: { ...BASE_GAME, winner: 'white' } });

      const promise = fetchLichessResult('abc123');

      await vi.advanceTimersByTimeAsync(0);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Default delay is 5s; nothing before it.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);

      await promise;
    });

    it('honours an HTTP-date Retry-After value', async () => {
      const now = Date.parse('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(now);
      const retryAt = new Date(now + 10_000).toUTCString();

      mockedAxios.get = vi
        .fn()
        .mockResolvedValueOnce({ status: 429, data: {}, headers: { 'retry-after': retryAt } })
        .mockResolvedValueOnce({ status: 200, data: { ...BASE_GAME, winner: 'white' } });

      const promise = fetchLichessResult('abc123');

      await vi.advanceTimersByTimeAsync(9_999);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);

      await promise;
    });

    it('throws RateLimitError after exhausting retries while still rate-limited', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({
        status: 429,
        data: {},
        headers: { 'retry-after': '1' },
      });

      const promise = fetchLichessResult('abc123');
      const assertion = expect(promise).rejects.toThrow(RateLimitError);

      // 3 retries (MAX_RETRIES) after the initial attempt, 1s apart.
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      await assertion;
      expect(mockedAxios.get).toHaveBeenCalledTimes(4);
    });
  });
});
