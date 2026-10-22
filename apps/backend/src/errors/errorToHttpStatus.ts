/**
 * Centralized error-to-HTTP-status mapping (#47).
 *
 * Before this module, each route/service picked its own status codes
 * ad-hoc (`match-service.ts`, `oracle-service.ts`, `validate-game-service.ts`
 * each hardcoded their own 400/404/409/500 literals, and route-level
 * catch-alls defaulted every unrecognized thrown error to 500 regardless of
 * its actual meaning). That let semantically identical failures — "resource
 * not found", "upstream rate limited" — end up with different status codes
 * depending on which code path raised them.
 *
 * `errorToHttpStatus()` is the single place that decision is made. Services
 * and routes should throw/construct one of the error classes below (or reuse
 * an existing domain error such as `RateLimitError`/`GameNotFoundError`)
 * rather than hardcoding a numeric status.
 */

import { ProviderFetchError } from '../fetchers/provider-validation.js';
import { RateLimitError } from './RateLimitError.js';
import { RpcTimeoutError } from './RpcTimeoutError.js';
import { GameNotFoundError as LichessFetcherGameNotFoundError } from '../fetchers/lichess.js';
import { GameNotFoundError as LichessServiceGameNotFoundError } from '../services/lichess.js';
import { UserNotFoundError } from '../services/elo.js';

/**
 * The request itself is invalid (missing/malformed fields, a value that
 * fails a business rule). Maps to 400: retrying the identical request will
 * never succeed until the caller changes it.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * The referenced resource does not exist. Maps to 404.
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * The request conflicts with existing state (e.g. a duplicate unique key).
 * Maps to 409.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

/**
 * Maps a thrown/caught error to the HTTP status code a route handler should
 * respond with. Falls back to 500 for anything unrecognized, since an
 * unrecognized error is, by definition, an unexpected server-side failure.
 */
export function errorToHttpStatus(error: unknown): number {
  if (error instanceof ProviderFetchError) {
    return error.policy === 'retry' ? 503 : 422;
  }

  // 400 — malformed/invalid input; the caller must change the request.
  if (error instanceof ValidationError) {
    return 400;
  }

  // 404 — the match, the game on the upstream chess platform, or the
  // upstream player account does not exist.
  if (
    error instanceof NotFoundError ||
    error instanceof LichessFetcherGameNotFoundError ||
    error instanceof LichessServiceGameNotFoundError ||
    error instanceof UserNotFoundError
  ) {
    return 404;
  }

  // 409 — conflicts with existing state (e.g. a duplicate gameId).
  if (error instanceof ConflictError) {
    return 409;
  }

  // 429 — an upstream API rate limit was hit after exhausting internal
  // retries. Distinct from 500 so callers know this is retryable, not a
  // permanent failure.
  if (RateLimitError.isRateLimitError(error)) {
    return 429;
  }

  // 504 — an upstream Soroban RPC call did not respond within its configured
  // timeout (#1718). Distinct from 500: the server itself is fine, a
  // downstream dependency did not respond in time.
  if (RpcTimeoutError.isRpcTimeoutError(error)) {
    return 504;
  }

  // 500 — anything else is an unexpected server-side failure.
  return 500;
}
