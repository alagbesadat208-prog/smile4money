import type { NormalizedGameResult } from './result.js';
import {
  AmbiguousEvidenceError,
  evidenceFor,
  normalizeResult,
} from './result.js';
import axios from 'axios';
import { RateLimitError } from '../errors/RateLimitError.js';

/** Maps to the on-chain MatchResult enum. */
export type MatchResult = 'Player1Wins' | 'Player2Wins' | 'Draw';

export interface GameResult {
  gameId: string;
  status: string;
  evidence?: import('./result.js').Evidence;
  endedAt?: string | null;
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
  'mate',
  'resign',
  'stalemate',
  'timeout',
  'draw',
  'outoftime',
  'variantEnd',
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
 */
export async function fetchLichessResult(gameId: string): Promise<NormalizedGameResult> {
  const token = process.env.LICHESS_API_TOKEN;
  const url = `https://lichess.org/game/export/${encodeURIComponent(gameId)}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await axios.get(url, {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

    const data = response.data as {
      id: string;
      lastMoveAt?: number;
      status: string;
      winner?: 'white' | 'black';
      players: {
        white: { user?: { name: string } };
        black: { user?: { name: string } };
      };
    };

    const evidence = evidenceFor('lichess', url, data);
    if (!data || data.id !== gameId)
      throw new AmbiguousEvidenceError('Mismatched game identity', evidence);
    const isTerminal = TERMINAL_STATUSES.has(data.status);
    const active = data.status === 'started' || data.status === 'created';
    let result: MatchResult | null = null;
    if (isTerminal) {
      if (data.winner === 'white') result = 'Player1Wins';
      else if (data.winner === 'black') result = 'Player2Wins';
      else if (
        data.winner === undefined &&
        ['draw', 'stalemate'].includes(data.status)
      )
        result = 'Draw';
      else
        throw new AmbiguousEvidenceError(
          'Terminal game has no valid outcome',
          evidence,
        );
      if (
        ['draw', 'stalemate'].includes(data.status) &&
        data.winner !== undefined
      ) {
        throw new AmbiguousEvidenceError(
          'Draw status conflicts with winner',
          evidence,
        );
      }
    } else if (!active || data.winner !== undefined) {
      throw new AmbiguousEvidenceError(
        'Unknown or conflicting Lichess status',
        evidence,
      );
    }
    return normalizeResult(
      data.id,
      data.players?.white?.user?.name,
      data.players?.black?.user?.name,
      result,
      data.lastMoveAt,
      'milliseconds',
      evidence,
    );
  }

  // Unreachable: the loop above always returns or throws.
  throw new RateLimitError('Lichess API rate limit exceeded (429)');
}
