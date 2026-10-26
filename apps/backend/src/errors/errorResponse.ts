/**
 * Standard API error envelope (#50).
 *
 * Before this module, every route built its own ad-hoc error JSON shape
 * (`{ error: "some string" }`, `{ error: "some string", details, hint }`,
 * `{ error: "unauthorized", message }`, `{ error: "rate_limit_exceeded",
 * message }` — four different shapes for four different concerns). API
 * consumers had no single, reliable field to branch on.
 *
 * Every error response now follows one schema:
 *
 *   { "error": { "code": "SOME_CODE", "message": "human-readable text" } }
 *
 * documented in docs/api-reference.md. Route handlers should build their
 * error body with `errorEnvelope()` below rather than hand-rolling one.
 */

/** Stable machine-readable error codes. Add new ones here as they're needed — keep this the single source of truth. */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    [extra: string]: unknown;
  };
}

/**
 * Builds the standard `{ error: { code, message } }` response body.
 *
 * `extra` merges additional diagnostic fields (e.g. a machine-readable
 * `hint`) into the `error` object, never onto the top-level response body —
 * every error response must have exactly one top-level key, `error`.
 */
export function errorEnvelope(
  code: ErrorCode | string,
  message: string,
  extra?: Record<string, unknown>,
): ErrorEnvelope {
  return { error: { code, message, ...extra } };
}

/**
 * Maps an HTTP status code to the matching {@link ErrorCode}.
 *
 * Several services (`match-service.ts`, `oracle-service.ts`,
 * `validate-game-service.ts`) already decide *which* status a failure maps
 * to (400/404/409/500) but don't carry a semantic label alongside it. This
 * lets route handlers derive a stable `code` from that existing status
 * without every service needing to be rewritten to also return one.
 */
export function statusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.VALIDATION_ERROR;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 422:
      return ErrorCode.VALIDATION_ERROR;
    case 429:
      return ErrorCode.RATE_LIMITED;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}
