import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { fetchChessDotComResult, GameNotFoundError } from '../../src/fetchers/chessdotcom.js';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

const makeGame = (gameId: string, whiteResult: string, blackResult: string) => ({
  url: `https://www.chess.com/game/live/${gameId}`,
  pgn: '',
  time_control: '600',
  start_time: 1700000000,
  end_time: 1700000060,
  white: { username: 'alice', result: whiteResult },
  black: { username: 'bob', result: blackResult },
});

beforeEach(() => { vi.clearAllMocks(); });

describe('fetchChessDotComResult', () => {
  it('returns Player1Wins when white wins', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { games: [makeGame('game42', 'win', 'resigned')] },
    });

    const result = await fetchChessDotComResult('alice', 'game42');
    expect(result.result).toBe('Player1Wins');
    expect(result.whitePlayer).toBe('alice');
    expect(result.blackPlayer).toBe('bob');
  });

  it('returns Player2Wins when black wins', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { games: [makeGame('game42', 'resigned', 'win')] },
    });

    const result = await fetchChessDotComResult('alice', 'game42');
    expect(result.result).toBe('Player2Wins');
  });

  it('returns Draw on stalemate', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { games: [makeGame('game42', 'stalemate', 'stalemate')] },
    });

    const result = await fetchChessDotComResult('alice', 'game42');
    expect(result.result).toBe('Draw');
  });

  it('returns null result for in-progress game', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { games: [makeGame('game42', 'in_progress', 'in_progress')] },
    });

    const result = await fetchChessDotComResult('alice', 'game42');
    expect(result.result).toBeNull();
    expect(result.status).toBe('in_progress');
  });

  it('throws GameNotFoundError when game not in any archive', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { games: [] },
    });

    await expect(fetchChessDotComResult('alice', 'missing')).rejects.toThrow(GameNotFoundError);
  });

  it('searches next month archive when not found in current month', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ status: 200, data: { games: [] } })        // month 0: not found
      .mockResolvedValueOnce({ status: 200, data: { games: [makeGame('game99', 'win', 'resigned')] } }); // month 1: found

    mockedAxios.get = get;
    const result = await fetchChessDotComResult('alice', 'game99');
    expect(result.result).toBe('Player1Wins');
    expect(get).toHaveBeenCalledTimes(2);
  });
});
