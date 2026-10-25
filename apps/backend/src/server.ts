import dotenv from 'dotenv';
dotenv.config();

import { app } from './app.js';
import { initializeQueue, closeQueue, startRetryWorker, startDlqEvictionTask, listDlqEntries, writeToDlq, type DlqEntry } from './queue.js';
import { initializeMatchStore } from './store/index.js';
import { initializeCircuitBreaker, closeCircuitBreakerStore } from './services/circuit-breaker.js';
import { PollingJobStore, PollingWorker, parsePollingIntervalMs } from './services/polling.js';
import ChessPlatformPoller from './services/game-poller.js';
import { getCurrentLedger } from './services/stellar.js';
import { retryDlqSubmission, type OracleSubmission } from './services/oracle-submit.js';
import { createShutdownHandler } from './shutdown.js';
import { resolveNetworkConfig } from './config/network.js';
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
 * One attempt per worker cycle via retryDlqSubmission (#122): a failure is
 * re-thrown so the entry stays in the DLQ with its attempt count incremented;
 * a result already on-chain resolves the entry without resubmitting.
 */
async function retryOracleSubmission(entry: DlqEntry): Promise<void> {
  try {
    await retryDlqSubmission(entry, submitOracleResultToContract, checkResultExistsOnChain);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { dlqId: entry.id, attempt: entry.attempts, error: message },
      'oracle_dlq: submission failed, entry will remain in DLQ'
    );
    throw err; // Re-throw so the entry stays in the DLQ
  }
}

async function main() {
  try {
    // #118 — fail fast on a network identity conflict (e.g. mainnet with the
    // testnet RPC, or another network's contract id) before touching any store.
    const network = resolveNetworkConfig(process.env);
    logger.info(
      { network: network.network, rpc_url_overridden: network.rpcUrlOverridden },
      'stellar_network_resolved',
    );

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
    const stopPollingWorker = pollingWorker.start();

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
      stopRetryWorker,
      stopDlqEviction,
      closeQueue,
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
