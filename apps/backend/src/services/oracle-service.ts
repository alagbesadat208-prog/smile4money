import { AmbiguousEvidenceError } from '../fetchers/result.js';
import {
  MemoryEvidenceStore,
  withGameLock,
  type EvidenceStore,
} from '../store/evidence-store.js';
/**
 * Oracle Service
 *
 * Contains all business logic for verifying chess game results before they
 * can be submitted on-chain. Route handlers in routes/oracle.ts delegate here
 * so that the logic can be tested independently of HTTP concerns.
 */

import { fetchLichessResult, GameNotFoundError } from '../fetchers/lichess.js';
import { fetchChessDotComResult } from '../fetchers/chessdotcom.js';
import {
  verifyPlayerIdentities,
  verifyIdentityHash,
} from './player-identity.js';
import type { PlayerIdentityMap } from './player-identity.js';
import type { MatchStore } from '../store/match-store.js';
import logger from '../logger.js';
import {
  errorToHttpStatus,
  ValidationError,
  NotFoundError,
} from '../errors/errorToHttpStatus.js';

export interface SubmitResultInput {
  matchId: number;
  gameId: string;
  platform: string;
  username?: string;
}

export interface SubmitResultSuccess {
  decisionId: number;
  ok: true;
  verified: true;
  matchId: number;
  gameId: string;
  result: import('../fetchers/lichess.js').MatchResult | null;
  whitePlayer: string;
  blackPlayer: string;
  status: string;
  message: string;
}

export interface SubmitResultFailure {
  ok: false;
  status: number;
  error: string;
  details?: string;
  hint?: string;
}

export type SubmitResultOutcome = SubmitResultSuccess | SubmitResultFailure;

/**
 * Validate the input fields for a submit-result request.
 *
 * Returns an error string if validation fails, or null if valid.
 */
export function validateSubmitResultInput(
  input: Partial<SubmitResultInput>,
): string | null {
  const { matchId, gameId, platform, username } = input;

  // #1717 — matchId is forwarded to the Stellar transaction builder, which
  // expects a positive integer (a contract-side u64 match id). A non-numeric
  // value, a float, zero, or a negative number must be rejected here, at the
  // route layer, rather than surfacing as a runtime error deep in the
  // transaction-building call stack.
  if (
    typeof matchId !== 'number' ||
    !Number.isInteger(matchId) ||
    matchId <= 0
  ) {
    return 'matchId must be a positive integer';
  }
  if (!gameId || typeof gameId !== 'string' || gameId.length === 0) {
    return 'gameId is required';
  }
  if (!platform || (platform !== 'lichess' && platform !== 'chessdotcom')) {
    return 'platform must be lichess or chessdotcom';
  }
  if (
    platform === 'chessdotcom' &&
    (!username || typeof username !== 'string')
  ) {
    return 'username is required for chessdotcom';
  }
  return null;
}

/**
 * Orchestrate the oracle result-verification flow:
 *   1. Find the match by gameId in the store
 *   2. Ensure player identities were captured at match creation
 *   3. Fetch the game result from the chess platform API
 *   4. Verify that the API players match the registered players
 *
 * Returns a discriminated union so the route handler only needs to map the
 * result to an HTTP response.
 */
const defaultEvidence = new WeakMap<object, EvidenceStore>();
export async function verifyGameResult(
  store: Pick<MatchStore, 'findByGameId' | 'count'>,
  input: SubmitResultInput,
  evidenceStore?: EvidenceStore,
): Promise<SubmitResultOutcome> {
  let ledger = evidenceStore ?? defaultEvidence.get(store);
  if (!ledger) {
    ledger = new MemoryEvidenceStore();
    defaultEvidence.set(store, ledger);
  }
  return withGameLock(input.gameId, () =>
    verifyUnlocked(store, input, ledger!),
  );
}

async function verifyUnlocked(
  store: Pick<MatchStore, 'findByGameId' | 'count'>,
  input: SubmitResultInput,
  ledger: EvidenceStore,
): Promise<SubmitResultOutcome> {
  const { matchId, gameId, platform } = input;

  // Fetch the match record
  const match = await store.findByGameId(gameId);
  if (!match) {
    const storeSize = await store.count();

    if (storeSize === 0) {
      logger.error(
        { game_id: gameId, match_id: matchId, store_count: 0 },
        'oracle_match_not_found_empty_store',
      );
      return {
        ok: false,
        status: errorToHttpStatus(new NotFoundError('Match not found')),
        error: 'Match not found',
        details: `No match found for gameId: ${gameId}. The match store is empty — the server may have restarted and lost in-memory state. Check your persistence configuration (QUEUE_STORE env var) and ensure matches are written to a durable store before deploying.`,
        hint: 'persistence_loss_suspected',
      };
    }

    logger.warn(
      { game_id: gameId, match_id: matchId, store_count: storeSize },
      'oracle_match_not_found',
    );
    return {
      ok: false,
      status: errorToHttpStatus(new NotFoundError('Match not found')),
      error: 'Match not found',
      details: `No match found for gameId: ${gameId}`,
    };
  }

  const history = await ledger.history(gameId);
  if (history[history.length - 1]?.state === 'review_required') {
    return { ok: false, status: 409, error: 'Operator review required' };
  }
  const record = async (
    state: 'review_required' | 'verified' | 'in_progress',
    reason: string,
    evidence?: import('../fetchers/result.js').Evidence,
  ) =>
    ledger.append({
      matchId: match.matchId,
      gameId,
      state,
      reason,
      evidence,
      recordedAt: new Date().toISOString(),
    });

  // Ensure player identities were captured at match creation
  if (!match.player1Username || !match.player2Username) {
    await record('review_required', 'Player identities not recorded');
    return {
      ok: false,
      status: errorToHttpStatus(
        new ValidationError('Player identities not recorded'),
      ),
      error: 'Player identities not recorded',
      details:
        'Match was created without capturing player identities from the API',
    };
  }

  // #1721 — the fetcher used to pull a result must be the platform the match
  // was actually created on (match.platform), never the caller-supplied
  // `platform` from the request body. Without this check, a caller could ask
  // the oracle to verify a Lichess match's gameId against the Chess.com API
  // (or vice versa) by simply passing a different `platform` value, which
  // would either fail confusingly deep in the fetcher or — if the gameId
  // happened to also resolve on the other platform — verify the wrong game
  // entirely. `match.platform` is immutable after creation, so it is the
  // only trustworthy source for which fetcher to use.
  if (platform !== match.platform) {
    return {
      ok: false,
      status: errorToHttpStatus(new ValidationError('Platform mismatch')),
      error: 'Platform mismatch',
      details: `Match ${match.matchId} was created on platform '${match.platform}', but this request specified '${platform}'. The platform used to verify a result must match the platform recorded at match creation.`,
    };
  }

  // Fetch the game result from the chess platform API, using the match's own
  // recorded platform (now confirmed consistent with the request above) as
  // the sole source of truth for fetcher selection.
  let apiResult;
  try {
    if (match.platform === 'lichess') {
      apiResult = await fetchLichessResult(gameId);
    } else if (match.platform === 'chessdotcom') {
      apiResult = await fetchChessDotComResult(match.player1Username, gameId);
    } else {
      return {
        ok: false,
        status: errorToHttpStatus(new ValidationError('Unknown platform')),
        error: 'Unknown platform',
        details: `Match ${match.matchId} has an unrecognized platform '${match.platform}'; expected 'lichess' or 'chessdotcom'.`,
      };
    }
  } catch (error) {
    if (error instanceof AmbiguousEvidenceError) {
      await record('review_required', error.message, error.evidence);
      return {
        ok: false,
        status: 409,
        error: 'Operator review required',
        details: error.message,
      };
    }
    if (error instanceof GameNotFoundError) {
      return {
        ok: false,
        status: errorToHttpStatus(error),
        error: 'Game not found on platform',
        details: error.message,
      };
    }
    throw error;
  }

  if (apiResult.gameId !== gameId) {
    await record(
      'review_required',
      'Provider game identity mismatch',
      apiResult.evidence,
    );
    return { ok: false, status: 409, error: 'Operator review required' };
  }
  // Build the identity map from the match record
  const identityMap: PlayerIdentityMap = {
    player1Address: match.player1,
    player1Username: match.player1Username,
    player2Address: match.player2,
    player2Username: match.player2Username,
    platform,
  };

  // Verify that the API players match the registered players
  const verification = verifyPlayerIdentities(match, apiResult, identityMap);
  if (!verification.valid) {
    await record(
      'review_required',
      'Player identity verification failed',
      apiResult.evidence,
    );
    return {
      ok: false,
      status: errorToHttpStatus(
        new ValidationError('Player identity verification failed'),
      ),
      error: 'Player identity verification failed',
      details: verification.error,
    };
  }

  // #1720 — the identity hash bound to the match at creation time must still
  // match a hash recomputed from its current fields. A divergence means the
  // identity captured at creation is no longer what the record now shows —
  // reject rather than accept a result against an identity that may have
  // been swapped after creation.
  const identityHashCheck = verifyIdentityHash(match);
  if (!identityHashCheck.valid) {
    await record(
      'review_required',
      'Identity hash verification failed',
      apiResult.evidence,
    );
    return {
      ok: false,
      status: errorToHttpStatus(
        new ValidationError('Identity hash verification failed'),
      ),
      error: 'Identity hash verification failed',
      details: identityHashCheck.error,
    };
  }

  if (!apiResult.evidence) {
    await record('review_required', 'Provider provenance missing');
    return { ok: false, status: 409, error: 'Operator review required' };
  }
  const previous = [...history].reverse().find((d) => d.state === 'verified');
  if (
    previous?.evidence?.outcome &&
    previous.evidence.outcome !== apiResult.result
  ) {
    await record(
      'review_required',
      'Provider outcome changed after verification',
      apiResult.evidence,
    );
    return { ok: false, status: 409, error: 'Operator review required' };
  }
  const decisionId = await record(
    apiResult.result === null ? 'in_progress' : 'verified',
    'Provider result verified',
    apiResult.evidence,
  );
  return {
    decisionId,
    ok: true,
    verified: true,
    matchId: match.matchId,
    gameId: apiResult.gameId,
    result: apiResult.result,
    whitePlayer: apiResult.whitePlayer,
    blackPlayer: apiResult.blackPlayer,
    status: apiResult.status,
    message: 'Game result verified. Players match registered identities.',
  };
}
