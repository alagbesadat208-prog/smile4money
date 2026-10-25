/**
 * Oracle submission service with exponential backoff retry logic.
 *
 * This service submits chess game results to the Stellar blockchain with automatic
 * retry on transient failures. Failed submissions are written to a dead-letter queue
 * after max retries are exhausted, where they remain for manual inspection and retry.
 *
 * Implements idempotent submission: if a result already exists on-chain for a match_id,
 * the submission is skipped and logged as informational, not an error.
 *
 * Configurable via environment variables:
 * - ORACLE_MAX_RETRIES: Maximum number of retry attempts (default: 5)
 * - ORACLE_RETRY_BASE_MS: Base interval for exponential backoff in milliseconds (default: 1000)
 * - ORACLE_RETRY_MAX_MS: Maximum interval between retries in milliseconds (default: 60000)
 */

import logger from '../logger.js';
import { DlqEntry, writeToDlq } from '../queue.js';

/** Configuration for retry behavior. */
export interface RetryConfig {
  /** Maximum number of retry attempts before writing to DLQ. */
  maxRetries: number;
  /** Base interval (ms) for exponential backoff: delay = base * (2 ^ attempt). */
  baseDelayMs: number;
  /** Maximum interval (ms) between retries; prevents unbounded growth. */
  maxDelayMs: number;
}

/** Submission details sent to the retry handler. */
export interface OracleSubmission {
  /** Escrow match ID. */
  matchId: number;
  /** Chess platform game ID. */
  gameId: string;
  /** Game outcome. */
  result: 'Player1Wins' | 'Player2Wins' | 'Draw';
}

/** Handler to check if a result already exists on-chain. */
export type ExistenceChecker = (matchId: number) => Promise<boolean>;

/** Result of a submission attempt. */
export interface SubmissionAttempt {
  /** Whether the attempt succeeded. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
  /** Retry delay (ms) for the next attempt if failed. */
  nextRetryDelayMs?: number;
}

/** Load retry configuration from environment. */
export function loadRetryConfig(): RetryConfig {
  return {
    maxRetries: parseInt(process.env.ORACLE_MAX_RETRIES ?? '5', 10),
    baseDelayMs: parseInt(process.env.ORACLE_RETRY_BASE_MS ?? '1000', 10),
    maxDelayMs: parseInt(process.env.ORACLE_RETRY_MAX_MS ?? '60000', 10),
  };
}

/**
 * Calculate exponential backoff delay for a given attempt number.
 *
 * Formula: delay = min(baseDelayMs * (2 ^ attempt), maxDelayMs)
 * Example (base=1000, max=60000):
 *   attempt 0: 1000ms (1s)
 *   attempt 1: 2000ms (2s)
 *   attempt 2: 4000ms (4s)
 *   attempt 3: 8000ms (8s)
 *   attempt 4: 16000ms (16s)
 *   attempt 5: 32000ms (32s)
 *   attempt 6+: 60000ms (60s, capped)
 */
export function calculateBackoffDelay(
  attempt: number,
  config: RetryConfig
): number {
  const exponential = config.baseDelayMs * Math.pow(2, attempt);
  return Math.min(exponential, config.maxDelayMs);
}

/**
 * Submit a chess result to the Stellar blockchain with exponential backoff retry.
 *
 * On transient failures (RPC timeout, fee bump needed, sequence number stale),
 * retries with exponential backoff up to maxRetries times. After all retries are
 * exhausted, the submission is written to the dead-letter queue for manual inspection.
 *
 * @param submission - The result to submit
 * @param handler - Async function to execute the actual blockchain submission
 * @param config - Retry configuration
 * @returns A DLQ entry if written, undefined if successful or still retrying
 */
export async function submitWithRetry(
  submission: OracleSubmission,
  handler: (sub: OracleSubmission) => Promise<void>,
  config: RetryConfig
): Promise<DlqEntry | undefined> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      await handler(submission);
      if (attempt > 0) {
        logger.info(
          { matchId: submission.matchId, attempt },
          'oracle_submit: success after retries'
        );
      }
      return undefined;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      if (attempt < config.maxRetries) {
        const nextDelay = calculateBackoffDelay(attempt + 1, config);
        logger.warn(
          {
            matchId: submission.matchId,
            attempt,
            nextRetryDelayMs: nextDelay,
            error: lastError.message,
          },
          'oracle_submit: transient failure, will retry'
        );
        await sleep(calculateBackoffDelay(attempt, config));
      }
    }
  }

  // All retries exhausted — write to DLQ. Awaited (#122): if the store itself
  // fails, the caller must see that the submission was NOT persisted, instead
  // of an unhandled rejection and a silently lost settlement.
  let dlqEntry: DlqEntry;
  try {
    dlqEntry = await writeToDlq(submission, lastError?.message ?? 'Unknown error');
  } catch (storeErr) {
    logger.error(
      {
        matchId: submission.matchId,
        gameId: submission.gameId,
        lastError: lastError?.message,
        storeError: storeErr instanceof Error ? storeErr.message : String(storeErr),
      },
      'oracle_submit: exhausted retries AND the DLQ write failed; submission is not persisted'
    );
    throw storeErr;
  }
  logger.error(
    {
      matchId: submission.matchId,
      dlqId: dlqEntry.id,
      attempts: config.maxRetries + 1,
      lastError: lastError?.message,
    },
    'oracle_submit: exhausted retries, written to DLQ'
  );
  return dlqEntry;
}

/**
 * Retry a previously failed submission from the dead-letter queue.
 *
 * Attempts the submission once with no retry logic. If it fails again,
 * the entry remains in the DLQ for the next retry cycle.
 *
 * @param entry - DLQ entry to retry
 * @param handler - Async function to execute the blockchain submission
 * @returns true if successful (entry should be removed from DLQ), false if it failed
 */
export async function retryDlqEntry(
  entry: DlqEntry,
  handler: (sub: OracleSubmission) => Promise<void>
): Promise<boolean> {
  try {
    const submission = entry.payload as OracleSubmission;
    await handler(submission);
    logger.info(
      { dlqId: entry.id, totalAttempts: entry.attempts },
      'oracle_submit: DLQ entry resolved'
    );
    return true;
  } catch (err) {
    logger.warn(
      {
        dlqId: entry.id,
        attempt: entry.attempts,
        error: err instanceof Error ? err.message : String(err),
      },
      'oracle_submit: DLQ retry failed'
    );
    return false;
  }
}

/**
 * Reprocess one DLQ entry: a single attempt, for the DLQ retry worker.
 *
 * Throws on any failure so the worker keeps the entry and records the attempt
 * (`attempts`, `lastAttemptAt`), which is what an operator reads to decide
 * whether to intervene. It never re-enters `submitWithRetry`: that ran a full
 * backoff loop inside the worker and then wrote a *new* DLQ entry and returned
 * normally, so the worker deleted the original and the attempt count restarted
 * at 0 every cycle (#122).
 *
 * The on-chain existence check is fail-closed here: if it cannot be answered,
 * nothing is submitted this cycle. The entry already failed once, and the
 * transaction may have landed without being confirmed, so guessing "not there"
 * risks a second submission.
 */
export async function retryDlqSubmission(
  entry: DlqEntry,
  handler: (sub: OracleSubmission) => Promise<void>,
  existenceChecker: ExistenceChecker
): Promise<'submitted' | 'already-on-chain'> {
  const submission = entry.payload as OracleSubmission;
  if (!submission || typeof submission !== 'object' || typeof submission.matchId !== 'number') {
    throw new Error(`Invalid DLQ entry payload: expected OracleSubmission, got ${typeof entry.payload}`);
  }

  let exists: boolean;
  try {
    exists = await existenceChecker(submission.matchId);
  } catch (err) {
    throw new Error(
      `existence check failed, not resubmitting this cycle: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (exists) {
    logger.info(
      { dlqId: entry.id, matchId: submission.matchId },
      'oracle_dlq: result already on-chain, resolving entry without resubmitting'
    );
    return 'already-on-chain';
  }

  await handler(submission);
  return 'submitted';
}

/**
 * Submit a result to the oracle contract with idempotence support.
 *
 * Before attempting to submit, checks if a result already exists for this match_id.
 * If yes, logs as informational and returns success (idempotent).
 * If no, attempts submission with exponential backoff retry.
 *
 * This protects against duplicate submissions when the oracle service crashes and
 * restarts mid-submission cycle.
 *
 * @param submission - The result to submit
 * @param handler - Async function to execute the actual blockchain submission
 * @param existenceChecker - Async function to check if result already exists on-chain
 * @param config - Retry configuration
 * @returns A DLQ entry if written, undefined if successful (including idempotent skips)
 */
export async function submitWithIdempotence(
  submission: OracleSubmission,
  handler: (sub: OracleSubmission) => Promise<void>,
  existenceChecker: ExistenceChecker,
  config: RetryConfig
): Promise<DlqEntry | undefined> {
  try {
    const alreadyExists = await existenceChecker(submission.matchId);
    if (alreadyExists) {
      logger.info(
        { matchId: submission.matchId, gameId: submission.gameId },
        'oracle_submit: result already exists on-chain, skipping'
      );
      return undefined;
    }
  } catch (err) {
    logger.warn(
      {
        matchId: submission.matchId,
        error: err instanceof Error ? err.message : String(err),
      },
      'oracle_submit: existence check failed, proceeding with submission'
    );
    // Continue with submission attempt even if existence check fails
  }

  return submitWithRetry(submission, handler, config);
}

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
