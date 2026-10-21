import axios from 'axios';
import { privateEnv } from '../config/private-env.js';
import { getLichessLimiterSingleton } from './bottleneck-limiters.js';
import logger from '../logger.js';

export class GameNotFoundError extends Error {
  constructor(gameId: string) {
    super(`Lichess game not found: ${gameId}`);
    this.name = 'GameNotFoundError';
  }
}

export interface LichessGame {
  id: string;
  winner?: 'white' | 'black';
  status: string;
  opening?: { name?: string };
}

export async function fetchLichessGame(gameId: string): Promise<LichessGame> {
  const token = privateEnv.lichessApiToken;
  const url = `https://lichess.org/api/game/${encodeURIComponent(gameId)}`;
  const limiter = getLichessLimiterSingleton();

  return limiter.schedule(async () => {
    try {
      const response = await axios.get(url, {
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: 10000,
        validateStatus: (status) => status < 500,
      });

      if (response.status === 404) {
        throw new GameNotFoundError(gameId);
      }

      if (response.status === 429) {
        throw new Error('Lichess API rate limit exceeded (429)');
      }

      if (response.status !== 200) {
        throw new Error(`Lichess API request failed with status ${response.status}`);
      }

      return response.data as LichessGame;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { gameId, error: message, url },
        'Lichess API request failed'
      );
      throw error;
    }
  });
}
