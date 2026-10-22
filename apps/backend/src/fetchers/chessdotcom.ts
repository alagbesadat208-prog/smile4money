import { providerGet, checkHttpStatus, quarantine, validateChronology } from './provider-validation.js';
import { getChessDotComLimiterSingleton } from '../services/bottleneck-limiters.js';
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
  start_time?: number;
  time_class?: string;
  white: { username: string; result: string };
  black: { username: string; result: string };
}

// https://www.chess.com/news/view/published-data-api#game-results-codes
const LOSS_RESULTS = new Set(['checkmated', 'resigned', 'timeout', 'lose', 'abandoned', 'kingofthehill', 'threecheck', 'bughousepartnerlose']);
const DRAW_RESULTS = new Set(['agreed', 'stalemate', 'repetition', 'insufficient', 'timevsinsufficient', '50move']);
const IN_PROGRESS = new Set(['in_progress', 'timeout_started']);

/** Extracts the game ID from a Chess.com game URL. */
function extractGameId(url: string): string {
  return url.split('/').pop() ?? url;
}

function mapResult(white: string, black: string): MatchResult | null {
  const known = (code: string) => code === 'win' || LOSS_RESULTS.has(code) || DRAW_RESULTS.has(code) || IN_PROGRESS.has(code);
  if (!known(white) || !known(black)) quarantine('Chess.com', 'unknown_termination_code');
  if (IN_PROGRESS.has(white) && IN_PROGRESS.has(black)) return null;
  if (white === 'win' && LOSS_RESULTS.has(black)) return 'Player1Wins';
  if (black === 'win' && LOSS_RESULTS.has(white)) return 'Player2Wins';
  if (DRAW_RESULTS.has(white) && DRAW_RESULTS.has(black)) return 'Draw';
  quarantine('Chess.com', 'inconsistent_termination_codes');
}

async function fetchArchive(username: string, year: number, month: number): Promise<ChessDotComGame[]> {
  const mm = String(month).padStart(2, '0');
  const url = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/${year}/${mm}`;
  const limiter = getChessDotComLimiterSingleton();

  return limiter.schedule(async () => {
    const response = await providerGet(url, {
      timeout: 10_000,
      validateStatus: () => true,
    });
    if (response.status === 404) return [];
    if (response.status === 429) {
      throw new RateLimitError('Chess.com API rate limit exceeded (429)');
    }
    checkHttpStatus('Chess.com', response.status);
    if (!response.data || !Array.isArray(response.data.games) ||
        response.data.games.some((g: ChessDotComGame) => !g || typeof g.url !== 'string')) {
      quarantine('Chess.com', 'malformed_archive');
    }
    return response.data.games as ChessDotComGame[];
  });
}

/**
 * Fetches a Chess.com game result by username + gameId.
 *
 * Searches the current month's archive first, then walks backwards up to 12 months.
 * Throws GameNotFoundError if the game is not found in any checked archive.
 * Returns result: null when the game is still in progress.
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
    const game = games.find((g) => extractGameId(g.url) === gameId);

    if (game) {
      if (typeof game.white?.username !== 'string' || typeof game.black?.username !== 'string' ||
          typeof game.white?.result !== 'string' || typeof game.black?.result !== 'string' || !game.white.username.trim() || !game.black.username.trim()) {
        quarantine('Chess.com', 'malformed_game');
      }
      const result = mapResult(game.white.result, game.black.result);
      if (result !== null) {
        if (typeof game.end_time !== 'number' || (game.start_time !== undefined && typeof game.start_time !== 'number')) {
          quarantine('Chess.com', 'invalid_chronology');
        }
        // Live archives omit start_time; their PGN provides UTCDate/UTCTime.
        const date = typeof game.pgn === 'string' ? /\[UTCDate "(\d{4}\.\d{2}\.\d{2})"\]/.exec(game.pgn)?.[1] : undefined;
        const time = typeof game.pgn === 'string' ? /\[UTCTime "(\d{2}:\d{2}:\d{2})"\]/.exec(game.pgn)?.[1] : undefined;
        const start = game.start_time === undefined
          ? (date && time ? Date.parse(`${date.replace(/\./g, '-')}T${time}Z`) : NaN)
          : game.start_time * 1000;
        validateChronology('Chess.com', start, game.end_time * 1000, game.time_class === 'daily');
      }
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
