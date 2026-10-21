import { createHash } from 'node:crypto';
import type { GameResult, MatchResult } from './lichess.js';

export const PARSER_VERSION = '2';
export interface Evidence {
  provider: 'lichess' | 'chessdotcom';
  fetchedAt: string;
  parserVersion: string;
  responseHash: string;
  source: string;
  outcome: MatchResult | null;
  endedAt: string | null;
}
export interface NormalizedGameResult extends GameResult {
  status: 'in_progress' | 'finished';
  endedAt: string | null;
  evidence: Evidence;
}
export class AmbiguousEvidenceError extends Error {
  constructor(
    message: string,
    public readonly evidence: Evidence,
  ) {
    super(message);
    this.name = 'AmbiguousEvidenceError';
  }
}

/** Hash the response for correlation; never persist raw payloads, PGN or profiles. */
export function evidenceFor(
  provider: Evidence['provider'],
  source: string,
  payload: unknown,
): Evidence {
  return {
    provider,
    source,
    fetchedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
    responseHash: createHash('sha256')
      .update(JSON.stringify(payload) ?? 'null')
      .digest('hex'),
    outcome: null,
    endedAt: null,
  };
}

export function normalizeResult(
  gameId: unknown,
  white: unknown,
  black: unknown,
  outcome: MatchResult | null,
  timestamp: unknown,
  unit: 'seconds' | 'milliseconds',
  evidence: Evidence,
): NormalizedGameResult {
  if (
    ![gameId, white, black].every(
      (v) => typeof v === 'string' && v.trim().length > 0,
    )
  ) {
    throw new AmbiguousEvidenceError(
      'Missing game or player identity',
      evidence,
    );
  }
  let endedAt: string | null = null;
  if (outcome !== null) {
    const ms =
      typeof timestamp === 'number'
        ? timestamp * (unit === 'seconds' ? 1000 : 1)
        : NaN;
    if (
      !Number.isFinite(ms) ||
      ms < 0 ||
      !Number.isFinite(new Date(ms).getTime())
    ) {
      throw new AmbiguousEvidenceError(
        'Missing or invalid terminal timestamp',
        evidence,
      );
    }
    endedAt = new Date(ms).toISOString();
  }
  return {
    gameId: gameId as string,
    whitePlayer: white as string,
    blackPlayer: black as string,
    status: outcome === null ? 'in_progress' : 'finished',
    result: outcome,
    endedAt,
    evidence: { ...evidence, outcome, endedAt },
  };
}
