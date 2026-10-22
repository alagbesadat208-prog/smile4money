import dotenv from 'dotenv';
dotenv.config();

import { app } from './app.js';
import { initializeQueue, closeQueue, startRetryWorker, startDlqEvictionTask, listDlqEntries, writeToDlq, type DlqEntry } from './queue.js';
import { initializeMatchStore, closeMatchStore, matchStore } from './store/index.js';
import { initializeCircuitBreaker, closeCircuitBreakerStore } from './services/circuit-breaker.js';
import { PollingJobStore, PollingWorker, parsePollingIntervalMs } from './services/polling.js';
import ChessPlatformPoller from './services/game-poller.js';
import { getCurrentLedger } from './services/stellar.js';
import { loadRetryConfig, submitWithIdempotence, type OracleSubmission } from './services/oracle-submit.js';
import { createShutdownHandler } from './shutdown.js';
import logger from './logger.js';

const port = Number(process.env.PORT || 4000);

/**
 * Placeholder for the actual Stellar contract submission handler.
 * This would be wired up with the Stellar SDK and oracle keypair.
 * For now, it throws to indicate this is not yet implemented.
 */
async function submitOracleResultToContract(submission: OracleSubmission): Promise<void> {
  // TODO: Implement actual Stellar contract submission
  // This should:
  // 1. Create a transaction builder
  // 2. Add the oracle contract's submit_result operation
  // 3. Sign with the oracle keypair
  // 4. Submit to Soroban RPC
  throw new Error('Oracle contract submission not yet implemented. Set up Stellar SDK and oracle keypair.');
}

/**
 * Placeholder for checking if a result already exists on-chain.
 * Used for idempotent submission (skip if already submitted).
 */
async function checkResultExistsOnChain(matchId: number): Promise<boolean> {
  // TODO: Implement existence check via Stellar RPC
  // This should query the oracle contract to see if a result exists for this matchId
  return false; // For now, assume it doesn't exist so retries will attempt submission
}

/**
 * Oracle retry handler for reprocessing DLQ entries.
 * 
 * Reconstructs the original OracleSubmission from the DLQ entry payload and attempts
 * to submit it to the blockchain with idempotence checks. If submission fails, the error
 * is thrown so the entry remains in the DLQ for the next retry cycle.
 */
async function retryOracleSubmission(entry: DlqEntry): Promise<void> {
  const submission = entry.payload as OracleSubmission;
  
  if (!submission || typeof submission !== 'object' || !('matchId' in submission)) {
    throw new Error(`Invalid DLQ entry payload: expected OracleSubmission, got ${typeof entry.payload}`);
  }

  logger.debug(
    { dlqId: entry.id, matchId: submission.matchId, gameId: submission.gameId },
    'oracle_dlq: retrying oracle submission'
  );

  const config = loadRetryConfig();
  
  try {
    // Attempt submission with idempotence check
    // If the result already exists on-chain, this returns cleanly
    // If submission fails, the error is thrown and propagates to the caller
    await submitWithIdempotence(
      submission,
      submitOracleResultToContract,
      checkResultExistsOnChain,
      config
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { dlqId: entry.id, matchId: submission.matchId, error: message },
      'oracle_dlq: submission failed, entry will remain in DLQ'
    );
    throw err; // Re-throw so the entry stays in the DLQ
  }
}

async function main() {
  try {
    // Initialize the persistent queue store
    await initializeQueue();
    logger.info('Queue store initialized');

    // Initialize the persistent match store (SQLite-backed)
    await initializeMatchStore();
    logger.info('Match store initialized');

    // Initialize the circuit breaker with SQLite-backed persistence (#1716),
    // restoring its prior state (or resetting to CLOSED if it went stale
    // while this process was down) before the retry worker starts using it.
    await initializeCircuitBreaker();
    logger.info('Circuit breaker initialized');

    // Load any pending jobs from the queue on startup
    const pendingEntries = await listDlqEntries();
    logger.info(
      { count: pendingEntries.length },
      `Loaded ${pendingEntries.length} pending oracle submissions from queue`
    );

    // Start the retry worker
    const stopRetryWorker = startRetryWorker(retryOracleSubmission, 60_000);

    // Start the DLQ TTL eviction task (deletes entries older than DLQ_TTL_DAYS)
    const stopDlqEviction = startDlqEvictionTask();

    // Set up the polling worker with DLQ wiring for max-attempts exceeded
    const pollingStore = new PollingJobStore();
    const gamePoller = new ChessPlatformPoller();
    const pollingWorker = new PollingWorker(pollingStore, gamePoller, {
      pollingIntervalMs: parsePollingIntervalMs(process.env.POLLING_INTERVAL_MS),
      maxPollingAttempts: Number(process.env.MAX_POLLING_ATTEMPTS ?? 1440),
      backoffMultiplier: Number(process.env.POLLING_BACKOFF_MULTIPLIER ?? 1.0),
      // #51 — lets the worker detect a match that has exceeded the escrow
      // contract's on-chain timeout_ledgers window and move it to DLQ
      // instead of polling a match no payout can still reach.
      getCurrentLedger,
      onGameCompleted: async (job, result) => {
        await matchStore.updateSettlementState(job.matchId, 'completed');
        logger.info(
          {
            match_id: job.matchId,
            game_id: job.gameId,
            platform: job.platform,
            result,
            attempts: job.pollingAttempt,
          },
          'polling_job_game_completed_submitting_to_oracle',
        );
        // TODO: invoke the oracle submission pipeline here
        // e.g. await submitToOracle({ matchId: job.matchId, gameId: job.gameId, result })
      },
      onMaxAttemptsExceeded: async (job, reason) => {
        await matchStore.updateSettlementState(job.matchId, 'failed');
        logger.error(
          {
            match_id: job.matchId,
            game_id: job.gameId,
            platform: job.platform,
            attempts: job.pollingAttempt,
            reason,
          },
          'polling_job_max_attempts_exceeded_writing_to_dlq',
        );
        await writeToDlq(
          { job },
          reason ?? 'max polling attempts exceeded',
        );
      },
    });
    const activeSettlementJobs = await matchStore.listActiveSettlementJobs();
    for (const job of activeSettlementJobs) {
      pollingStore.ensureJob(job.matchId, job.gameId, job.platform, job.username);
    }
    const stopPollingWorker = pollingWorker.start();

    // Deliver committed work at least once. The durable job table restores
    // active work across restarts; ensureJob makes an interrupted replay safe.
    let dispatching = false;
    let dispatchPromise: Promise<void> | null = null;
    const dispatchOutbox = async () => {
      if (dispatching) return;
      dispatching = true;
      dispatchPromise = (async () => {
        try {
          await matchStore.dispatchOutbox(async (event) => {
            const payload = event.payload as {
              matchId: number;
              gameId: string;
              platform: 'lichess' | 'chessdotcom';
              username?: string;
            };
            pollingStore.ensureJob(payload.matchId, payload.gameId, payload.platform, payload.username);
            await matchStore.updateSettlementState(payload.matchId, 'processing');
          });
          await matchStore.cleanupTerminalWork();
        } catch (error) {
          logger.error({ error }, 'settlement_outbox_dispatch_failed');
        } finally {
          dispatching = false;
        }
      })();
      try {
        await dispatchPromise;
      } finally {
        dispatchPromise = null;
      }
    };
    void dispatchOutbox();
    const outboxTimer = setInterval(() => void dispatchOutbox(), 1000);
    outboxTimer.unref?.();

    // Start the Express server
    const server = app.listen(port, () => {
      logger.info(
        { port },
        `smile4money-backend listening on http://localhost:${port}`
      );
    });

    // Graceful shutdown (#1719) — see shutdown.ts for the full sequencing
    // rationale (stop accepting new connections, drain in-flight work, close
    // stores, force-exit on timeout).
    const shutdown = createShutdownHandler({
      server,
      stopPollingWorker,
      stopOutboxDispatcher: async () => {
        clearInterval(outboxTimer);
        await dispatchPromise;
      },
      stopRetryWorker,
      stopDlqEviction,
      closeQueue,
      closeMatchStore,
      closeCircuitBreakerStore,
      logger,
      shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 30_000),
    });

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

main();
