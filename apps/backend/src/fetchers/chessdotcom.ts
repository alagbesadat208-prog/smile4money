import type { NormalizedGameResult } from './result.js';
import {
  AmbiguousEvidenceError,
  evidenceFor,
  normalizeResult,
} from './result.js';
import axios from 'axios';
import { getChessDotComLimiterSingleton } from '../services/bottleneck-limiters.js';
import logger from '../logger.js';
import { RateLimitError } from '../errors/RateLimitError.js';
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

const LOSS_RESULTS = new Set([
  'checkmated',
  'resigned',
  'timeout',
  'abandoned',
  'lose',
  'kingofthehill',
  'threecheck',
  'bughousepartnerlose',
]);
const DRAW_RESULTS = new Set([
  'agreed',
  'stalemate',
  'repetition',
  'insufficient',
  'timevsinsufficient',
  '50move',
]);
const IN_PROGRESS = new Set(['in_progress', 'timeout_started']);

/** Extracts the game ID from a Chess.com game URL. */
function extractGameId(url: string): string {
  return url.split('/').pop() ?? url;
}

function mapResult(
  white: string,
  black: string,
): MatchResult | null | undefined {
  if (IN_PROGRESS.has(white) && IN_PROGRESS.has(black)) return null;
  if (white === 'win' && LOSS_RESULTS.has(black)) return 'Player1Wins';
  if (black === 'win' && LOSS_RESULTS.has(white)) return 'Player2Wins';
  if (DRAW_RESULTS.has(white) && DRAW_RESULTS.has(black)) return 'Draw';
  return undefined;
}

export function parseArchiveMonths(
  raw = process.env.CHESSDOTCOM_ARCHIVE_MONTHS,
): number {
  const months = raw === undefined ? 120 : Number(raw);
  if (!Number.isInteger(months) || months < 1 || months > 600) {
    throw new Error(
      'CHESSDOTCOM_ARCHIVE_MONTHS must be an integer between 1 and 600',
    );
  }
  return months;
}

async function fetchArchive(
  username: string,
  year: number,
  month: number,
): Promise<ChessDotComGame[]> {
  const mm = String(month).padStart(2, '0');
  const url = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/${year}/${mm}`;
  const limiter = getChessDotComLimiterSingleton();

  return limiter.schedule(async () => {
    try {
      const response = await axios.get(url, {
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

      if (
        !Array.isArray(response.data?.games) ||
        !response.data.games.every((g: any) => g && typeof g.url === 'string')
      ) {
        throw new AmbiguousEvidenceError(
          'Invalid archive payload',
          evidenceFor('chessdotcom', url, response.data),
        );
      }
      return response.data.games;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { username, year, month, url, error: message },
        'Chess.com API archive fetch failed',
      );
      throw error;
    }
  });
}

/**
 * Fetches a Chess.com game result by username + gameId.
 *
 * Searches UTC monthly archives backwards, bounded by CHESSDOTCOM_ARCHIVE_MONTHS (default 120, maximum 600).
 * Throws GameNotFoundError if the game is not found in any checked archive.
 * Returns result: null when the game is still in progress.
 * Player1 = white, Player2 = black.
 */
export async function fetchChessDotComResult(
  username: string,
  gameId: string,
): Promise<NormalizedGameResult> {
  const { GameNotFoundError } = await import('./lichess.js');

  const now = new Date();
  const months = parseArchiveMonths();
  for (let i = 0; i < months; i++) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;

    const games = await fetchArchive(username, year, month);
    const matches = games.filter((g) => extractGameId(g.url) === gameId);
    if (matches.length > 1)
      throw new AmbiguousEvidenceError(
        'Duplicate game evidence',
        evidenceFor('chessdotcom', `game:${gameId}`, matches),
      );
    const game = matches[0];

    if (game) {
      const evidence = evidenceFor(
        'chessdotcom',
        `https://www.chess.com/game/live/${encodeURIComponent(gameId)}`,
        game,
      );
      const result = mapResult(game.white?.result, game.black?.result);
      if (result === undefined)
        throw new AmbiguousEvidenceError(
          'Conflicting or unknown Chess.com outcomes',
          evidence,
        );
      return normalizeResult(
        gameId,
        game.white?.username,
        game.black?.username,
        result,
        game.end_time,
        'seconds',
        evidence,
      );
    }
  }

  throw new GameNotFoundError(gameId);
}
