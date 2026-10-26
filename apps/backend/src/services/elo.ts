/**
 * Lichess ELO rating lookup for stake pricing.
 *
 * Lichess exposes a public per-user rating endpoint that needs no OAuth scope
 * beyond the standard token this service already sends for game lookups:
 *
 * ```text
 * GET https://lichess.org/api/user/{username}
 * ```
 *
 * ## Why the rating is resolved at match creation
 *
 * The multiplier is a function of both players' ratings *at the moment the
 * match is created*. Fetching later — say, when the result comes in — would
 * let a rating change between stake and payout, so the multiplier the winner was
 * promised would no longer be the one the formula produces. Reading both
 * ratings once, at creation, and storing them alongside the multiplier makes
 * the price a function of committed inputs.
 *
 * ## Failure is non-fatal by design
 *
 * A rating lookup is a *pricing input*, not a correctness input. If Lichess is
 * down, rate-limits us, or the username is unknown, the match must still be
 * creatable at the base stake. Every failure path here resolves to `null`
 * rather than throwing, and the caller turns that into multiplier 1 via
 * `resolveMultiplier`. See `elo-multiplier.ts` for why the fallback is the
 * conservative direction.
 *
 * Rate limiting goes through the shared Lichess limiter, so rating lookups
 * compete for the same budget as game polls rather than multiplying the
 * request rate against Lichess' published limits.
 */

import axios from 'axios';
import { privateEnv } from '../config/private-env.js';
import { getLichessLimiterSingleton } from './bottleneck-limiters.js';
import logger from '../logger.js';
import { resolveMultiplier, type EloMultiplierResult } from './elo-multiplier.js';

/** The subset of Lichess' user payload this service needs. */
interface LichessUserResponse {
  id: string;
  username: string;
  perfs?: Record<string, { rating?: number }>;
}

/**
 * Chess variants to try, in order, when picking a rating for a user.
 *
 * A player whose account has only ever played one variant should still be
 * priced. `blitz` leads because it is the most common form of rated casual
 * play on Lichess; the rest are fallbacks. The order is the contract: the
 * first variant the user actually has a rating for wins.
 */
export const RATING_VARIANT_PREFERENCE = [
  'blitz',
  'bullet',
  'rapid',
  'classical',
] as const;

/** Minimal injectable surface, so tests need no module mocking. */
export interface EloFetcherDeps {
  get?: <T>(url: string) => Promise<T>;
}

/** Raised when Lichess has no user by that name. */
export class UserNotFoundError extends Error {
  constructor(username: string) {
    super(`Lichess user not found: ${username}`);
    this.name = 'UserNotFoundError';
  }
}

/** Build the authenticated GET used for every Lichess call in this service. */
function defaultGet<T>(url: string): Promise<T> {
  const token = privateEnv.lichessApiToken;
  return axios
    .get<T>(url, {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 10_000,
      // Accept 404 so it resolves to a normal `null` below rather than an
      // axios throw that would have to be caught to mean the same thing.
      validateStatus: (status) => status < 500,
    })
    .then((response) => {
      if (response.status === 404) {
        throw new UserNotFoundError(url);
      }
      if (response.status === 429) {
        throw new Error('Lichess API rate limit exceeded (429)');
      }
      if (response.status !== 200) {
        throw new Error(`Lichess API request failed with status ${response.status}`);
      }
      return response.data;
    });
}

/**
 * Pick a single rating number for a user.
 *
 * Returns the first rating available in `RATING_VARIANT_PREFERENCE` order, or
 * `null` if the account has no rated games in any of them (a brand-new
 * account, or one that only plays casual). Null is a normal outcome, not an
 * error.
 */
export function selectRating(
  perfs: Record<string, { rating?: number }> | undefined,
): number | null {
  if (!perfs) return null;

  for (const variant of RATING_VARIANT_PREFERENCE) {
    const rating = perfs[variant]?.rating;
    if (typeof rating === 'number' && Number.isFinite(rating)) {
      return rating;
    }
  }
  return null;
}

/**
 * Fetch one player's rating.
 *
 * Resolves to `null` for every failure — unknown user, rate limit, network
 * error, malformed payload. The caller treats `null` as "price this player at
 * the floor", which is the safe direction.
 */
export async function fetchLichessElo(
  username: string,
  deps: EloFetcherDeps = {},
): Promise<number | null> {
  if (!username || !username.trim()) {
    return null;
  }

  const get = deps.get ?? defaultGet;
  const url = `https://lichess.org/api/user/${encodeURIComponent(username.trim())}`;

  try {
    // Scheduled through the shared limiter so rating lookups and game polls
    // draw from one budget against Lichess' rate limit.
    const user = await getLichessLimiterSingleton().schedule(() =>
      get<LichessUserResponse>(url),
    );
    const rating = selectRating(user?.perfs);

    if (rating === null) {
      logger.debug({ username }, 'Lichess user has no rated games; using fallback rating');
    }
    return rating;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // Warn, not error: this degrades the stake, it does not fail the match.
    logger.warn({ username, error: message }, 'Lichess ELO lookup failed; falling back');
    return null;
  }
}

/**
 * Fetch both players' ratings and resolve the stake multiplier.
 *
 * Both lookups run concurrently — they are independent, and serialising them
 * would double the wall-clock cost of match creation.
 */
export async function resolveMatchMultiplier(
  player1Username: string,
  player2Username: string,
  deps: EloFetcherDeps = {},
): Promise<EloMultiplierResult> {
  const [elo1, elo2] = await Promise.all([
    fetchLichessElo(player1Username, deps),
    fetchLichessElo(player2Username, deps),
  ]);

  return resolveMultiplier(elo1, elo2);
}
