import axios from 'axios';
import { getChessDotComLimiterSingleton } from '../services/bottleneck-limiters.js';
import logger from '../logger.js';
import { RateLimitError } from '../errors/RateLimitError.js';
import { ProviderSchemaError } from '../errors/ProviderSchemaError.js';
import { traceHeaders } from '../tracing/trace-context.js';
import type { MatchResult, GameResult } from './lichess.js';

export { GameNotFoundError } from './lichess.js';
export { RateLimitError } from '../errors/RateLimitError.js';
export type { MatchResult, GameResult };

interface ChessDotComGame {
  url: string;
  pgn: string;
  time_control: string;
  end_time: number;
  white: { username: string; result: string };
  black: { username: string; result: string };
}

const WIN_RESULTS = new Set(['win']);
const DRAW_RESULTS = new Set(['agreed', 'stalemate', 'repetition', 'insufficient', 'timevsinsufficient', '50move']);
/** The losing side's code when the other side has 'win'. */
const LOSS_RESULTS = new Set([
  'checkmated', 'resigned', 'timeout', 'abandoned', 'lose',
  'kingofthehill', 'threecheck', 'bughousepartnerlose',
]);
const IN_PROGRESS = new Set(['in_progress', 'timeout_started']);
const KNOWN_RESULTS = new Set([...WIN_RESULTS, ...DRAW_RESULTS, ...LOSS_RESULTS, ...IN_PROGRESS]);

/** Extracts the game ID from a Chess.com game URL. */
function extractGameId(url: string): string {
  return url.split('/').pop() ?? url;
}

/**
 * Maps a pair of Chess.com result codes to a MatchResult.
 *
 * Any code outside the known sets throws ProviderSchemaError. The previous
 * fallback treated every unrecognised code as a draw, so a renamed or new
 * code would have settled a wager as a draw with no error (issue #121).
 */
function mapResult(white: string, black: string): MatchResult | null {
  for (const code of [white, black]) {
    if (!KNOWN_RESULTS.has(code)) {
      throw new ProviderSchemaError('chessdotcom', `unknown result code ${JSON.stringify(code)}`);
    }
  }
  if (IN_PROGRESS.has(white) || IN_PROGRESS.has(black)) return null;
  if (WIN_RESULTS.has(white) && WIN_RESULTS.has(black)) {
    throw new ProviderSchemaError('chessdotcom', 'both players reported as winners');
  }
  if (WIN_RESULTS.has(white)) return 'Player1Wins';
  if (WIN_RESULTS.has(black)) return 'Player2Wins';
  if (DRAW_RESULTS.has(white) || DRAW_RESULTS.has(black)) return 'Draw';
  // Both sides carry a loss code and nobody won (e.g. both abandoned).
  return 'Draw';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks the fields a matched game's result mapping depends on. */
function parsePlayers(game: Record<string, unknown>): ChessDotComGame {
  for (const side of ['white', 'black'] as const) {
    const player = game[side];
    if (!isObject(player) || typeof player.username !== 'string' || typeof player.result !== 'string') {
      throw new ProviderSchemaError('chessdotcom', `${side}.username/${side}.result missing`);
    }
  }
  return game as unknown as ChessDotComGame;
}

async function fetchArchive(username: string, year: number, month: number): Promise<ChessDotComGame[]> {
  const mm = String(month).padStart(2, '0');
  const url = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/${year}/${mm}`;
  const limiter = getChessDotComLimiterSingleton();

  return limiter.schedule(async () => {
    try {
      const response = await axios.get(url, {
        // #123 — continue the active trace into the provider call.
        headers: traceHeaders(),
        timeout: 10_000,
        validateStatus: (s) => s < 500,
      });

      if (response.status === 404) {
        return [];
      }

      if (response.status === 429) {
        throw new RateLimitError('Chess.com API rate limit exceeded (429)');
      }

      if (response.status !== 200) {
        throw new Error(`Chess.com API error: ${response.status}`);
      }

      const data: unknown = response.data;
      if (!isObject(data)) {
        throw new ProviderSchemaError('chessdotcom', 'archive body is not an object');
      }
      if (data.games === undefined) return [];
      if (!Array.isArray(data.games)) {
        throw new ProviderSchemaError('chessdotcom', 'archive games is not an array');
      }
      // Entries are only checked once matched; one odd entry in a month's
      // archive must not block every other game in it.
      return data.games as ChessDotComGame[];
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { username, year, month, url, error: message },
        'Chess.com API archive fetch failed'
      );
      throw error;
    }
  });
}

/**
 * Fetches a Chess.com game result by username + gameId.
 *
 * Searches the current month's archive first, then walks backwards up to 12 months.
 * Throws GameNotFoundError if the game is not found in any checked archive.
 * Returns result: null when the game is still in progress.
 * Throws ProviderSchemaError for a malformed archive or matched game, or an
 * unknown result code.
 * Player1 = white, Player2 = black.
 */
export async function fetchChessDotComResult(username: string, gameId: string): Promise<GameResult> {
  const { GameNotFoundError } = await import('./lichess.js');

  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const games = await fetchArchive(username, year, month);
    const match = games.find((g) => isObject(g) && typeof g.url === 'string' && extractGameId(g.url) === gameId);

    if (match) {
      const game = parsePlayers(match as unknown as Record<string, unknown>);
      const result = mapResult(game.white.result, game.black.result);
      return {
        gameId,
        status: result === null ? 'in_progress' : 'finished',
        whitePlayer: game.white.username,
        blackPlayer: game.black.username,
        result,
      };
    }
  }

  throw new GameNotFoundError(gameId);
}
