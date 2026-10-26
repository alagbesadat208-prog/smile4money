import axios from 'axios';
import { RateLimitError } from '../errors/RateLimitError.js';
import { ProviderSchemaError } from '../errors/ProviderSchemaError.js';
import { traceHeaders } from '../tracing/trace-context.js';

/** Maps to the on-chain MatchResult enum. */
export type MatchResult = 'Player1Wins' | 'Player2Wins' | 'Draw';

export interface GameResult {
  gameId: string;
  status: string;
  whitePlayer: string;
  blackPlayer: string;
  result: MatchResult | null; // null when game is still in progress
}

export class GameNotFoundError extends Error {
  constructor(gameId: string) {
    super(`Lichess game not found: ${gameId}`);
    this.name = 'GameNotFoundError';
  }
}

const TERMINAL_STATUSES = new Set([
  'mate', 'resign', 'stalemate', 'timeout', 'draw', 'outoftime',
  'cheat', 'noStart', 'unknownFinish', 'variantEnd',
]);

/** Used when a 429 response has no Retry-After header at all. */
const DEFAULT_RETRY_AFTER_MS = 5_000;

/**
 * Maximum number of 429 retries within a single `fetchLichessResult` call
 * before giving up and surfacing a RateLimitError. The outer polling loop
 * (see services/polling.ts) already retries the whole job on its normal
 * cycle, so this only needs to absorb a handful of Retry-After waits before
 * handing back control rather than retry indefinitely.
 */
const MAX_RETRIES = 3;

/**
 * Parses a Retry-After header value into a wait duration in milliseconds.
 *
 * Per RFC 9110 §10.2.3, the header is either a non-negative integer number of
 * seconds, or an HTTP-date. Falls back to DEFAULT_RETRY_AFTER_MS when the
 * header is absent, unparseable, or names a date already in the past.
 */
function parseRetryAfterMs(headerValue: string | undefined): number {
  if (!headerValue) return DEFAULT_RETRY_AFTER_MS;

  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return DEFAULT_RETRY_AFTER_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LichessGamePayload {
  id: string;
  status: string;
  winner?: 'white' | 'black';
  players: {
    white: { user?: { name: string } };
    black: { user?: { name: string } };
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks the fields the result mapping depends on. Extra fields are ignored,
 * so additive provider changes keep working; a missing or retyped field
 * throws ProviderSchemaError instead of a TypeError or a wrong result.
 */
function parseLichessGame(data: unknown): LichessGamePayload {
  if (!isObject(data)) throw new ProviderSchemaError('lichess', 'body is not an object');
  if (typeof data.id !== 'string') throw new ProviderSchemaError('lichess', 'id is not a string');
  if (typeof data.status !== 'string') throw new ProviderSchemaError('lichess', 'status is not a string');
  if (data.winner !== undefined && data.winner !== 'white' && data.winner !== 'black') {
    throw new ProviderSchemaError('lichess', `unknown winner ${JSON.stringify(data.winner)}`);
  }
  const players = data.players;
  if (!isObject(players) || !isObject(players.white) || !isObject(players.black)) {
    throw new ProviderSchemaError('lichess', 'players.white/players.black missing');
  }
  for (const side of ['white', 'black'] as const) {
    const user = (players[side] as Record<string, unknown>).user;
    if (user !== undefined && !(isObject(user) && typeof user.name === 'string')) {
      throw new ProviderSchemaError('lichess', `players.${side}.user.name is not a string`);
    }
  }
  return data as unknown as LichessGamePayload;
}

/**
 * Fetches a Lichess game result and returns a normalised GameResult.
 *
 * - Throws GameNotFoundError on HTTP 404.
 * - On HTTP 429, reads the Retry-After header (seconds or HTTP-date; a safe
 *   default is used when it is absent) and waits that long before retrying,
 *   up to MAX_RETRIES times. Throws RateLimitError if still rate-limited
 *   after that — callers already treat RateLimitError as "retry later"
 *   rather than a permanent failure (see services/game-poller.ts).
 * - Returns result: null when the game is still in progress.
 * - Maps winner field to MatchResult (Player1 = white, Player2 = black).
 * - Throws ProviderSchemaError when the body is missing a field the mapping
 *   needs, so a provider schema change fails the poll instead of settling.
 */
export async function fetchLichessResult(gameId: string): Promise<GameResult> {
  const token = process.env.LICHESS_API_TOKEN;
  const url = `https://lichess.org/api/game/${encodeURIComponent(gameId)}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await axios.get(url, {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // #123 — continue the active trace into the provider call.
        ...traceHeaders(),
      },
      timeout: 10_000,
      validateStatus: (s) => s < 500,
    });

    if (response.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new RateLimitError(
          `Lichess API rate limit exceeded (429) after ${MAX_RETRIES} retries`,
        );
      }
      const retryAfterMs = parseRetryAfterMs(response.headers?.['retry-after']);
      await sleep(retryAfterMs);
      continue;
    }

    if (response.status === 404) {
      throw new GameNotFoundError(gameId);
    }

    if (response.status !== 200) {
      throw new Error(`Lichess API error: ${response.status}`);
    }

    const data = parseLichessGame(response.data);

    const isTerminal = TERMINAL_STATUSES.has(data.status);
    let result: MatchResult | null = null;
    if (isTerminal) {
      if (data.winner === 'white') result = 'Player1Wins';
      else if (data.winner === 'black') result = 'Player2Wins';
      else result = 'Draw';
    }

    return {
      gameId: data.id,
      status: data.status,
      whitePlayer: data.players.white.user?.name ?? 'unknown',
      blackPlayer: data.players.black.user?.name ?? 'unknown',
      result,
    };
  }

  // Unreachable: the loop above always returns or throws.
  throw new RateLimitError('Lichess API rate limit exceeded (429)');
}
