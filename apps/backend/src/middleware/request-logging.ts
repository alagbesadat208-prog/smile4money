/**
 * Request logging middleware (#1722).
 *
 * Logs one INFO-level line per request (method, path, status, duration) with
 * no request body at all — safe at any log level, in any environment.
 *
 * A second, DEBUG-only line additionally includes the request body, but only
 * after redacting fields considered sensitive (see SENSITIVE_FIELDS below).
 * Because `logger.ts` only emits DEBUG output when LOG_LEVEL=debug (or
 * NODE_ENV is not production), this line — redacted or not — never reaches
 * production logs under the default configuration. The redaction happens
 * regardless, as defense in depth against LOG_LEVEL being explicitly set to
 * debug in production.
 *
 * Sensitive fields and why:
 * - `player1`, `player2`, `address`, `walletAddress`, `stellarAddress` —
 *   Stellar wallet addresses. Pseudonymous but linkable to a specific person
 *   via on-chain activity, and treated as personal data under some
 *   jurisdictions' privacy laws (e.g. GDPR's "pseudonymous data").
 * - `username` — the player's chess-platform handle (Lichess/Chess.com),
 *   which is frequently the player's real name or links to a public profile.
 * - `password`, `secret`, `apiKey`, `privateKey` — credentials. Never
 *   belong in logs at any level, redacted here as defense in depth even
 *   though none of this backend's current routes accept them in a body.
 */
import type { NextFunction, Request, Response } from 'express';
import logger from '../logger.js';

const SENSITIVE_FIELDS = new Set([
  'player1',
  'player2',
  'address',
  'walletaddress',
  'stellaraddress',
  'username',
  'password',
  'secret',
  'apikey',
  'privatekey',
  'signedtxxdr',
]);

const REDACTED = '[REDACTED]';

/**
 * Returns a shallow copy of `body` with every key in SENSITIVE_FIELDS
 * (case-insensitive) replaced by a fixed redaction marker. Not recursive by
 * design: this backend's request bodies are flat, and a shallow redaction is
 * easier to reason about (and to audit the field list against) than a deep
 * one that could silently redact — or silently miss — a nested field.
 */
export function redactSensitiveFields(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_FIELDS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return redacted;
}

/**
 * Express middleware: logs one INFO line per request (no body, ever) and,
 * only when DEBUG-level output is enabled, one additional DEBUG line
 * carrying the redacted request body.
 */
export function requestLogging() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;

      // INFO level (or above): method/path/status/duration only. No body
      // field at all — not even a redacted one — so there is nothing for a
      // misconfigured redaction list to leak at this level.
      logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: durationMs,
        },
        'http_request',
      );

      // DEBUG level only: redacted body, for local troubleshooting. Skipped
      // entirely (not just omitted from a shared log line) when DEBUG is not
      // enabled, so building the redacted copy never happens in production.
      if (logger.isLevelEnabled('debug') && req.body && Object.keys(req.body).length > 0) {
        logger.debug(
          {
            method: req.method,
            path: req.path,
            body: redactSensitiveFields(req.body),
          },
          'http_request_body',
        );
      }
    });

    next();
  };
}

export default requestLogging;
