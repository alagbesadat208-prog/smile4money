import {
  OracleContractTransport,
  oracleNetworkPassphrase,
} from './services/oracle-contract.js';
import { sqliteSettings } from './store/sqlite-config.js';
import { rpc } from '@stellar/stellar-sdk';
import {
  createManagedSignerProvider,
  managedSubmissionHandler,
} from './services/oracle-signer.js';
import dotenv from 'dotenv';
dotenv.config();

import { app } from './app.js';
import {
  initializeQueue,
  closeQueue,
  startRetryWorker,
  startDlqEvictionTask,
  listDlqEntries,
  writeToDlq,
  type DlqEntry,
} from './queue.js';
import { initializeMatchStore } from './store/index.js';
import {
  initializeCircuitBreaker,
  closeCircuitBreakerStore,
} from './services/circuit-breaker.js';
import {
  PollingJobStore,
  PollingWorker,
  parsePollingIntervalMs,
} from './services/polling.js';
import ChessPlatformPoller from './services/game-poller.js';
import { getCurrentLedger } from './services/stellar.js';
import { type OracleSubmission } from './services/oracle-submit.js';
import { createShutdownHandler } from './shutdown.js';
import logger from './logger.js';

const port = Number(process.env.PORT || 4000);

const signerRpc = new rpc.Server(
  process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  { timeout: 10000 },
);
const contractId = process.env.CONTRACT_ORACLE || '';
const signerProvider = createManagedSignerProvider(signerRpc, contractId);
const oracleTransport = new OracleContractTransport(
  signerRpc,
  contractId,
  oracleNetworkPassphrase(),
);
const submitOracleResultToContract = managedSubmissionHandler(
  signerProvider,
  (submission, signer) => oracleTransport.submit(submission, signer),
);

/**
 * Oracle retry handler for reprocessing DLQ entries.
 *
 * Reconstructs the original OracleSubmission from the DLQ entry payload and attempts
 * to submit it to the blockchain with idempotence checks. If submission fails, the error
 * is thrown so the entry remains in the DLQ for the next retry cycle.
 */
async function retryOracleSubmission(entry: DlqEntry): Promise<void> {
  const submission = entry.payload as OracleSubmission;

  if (
    !submission ||
    typeof submission !== 'object' ||
    !('matchId' in submission)
  ) {
    throw new Error(
      `Invalid DLQ entry payload: expected OracleSubmission, got ${typeof entry.payload}`,
    );
  }

  logger.debug(
    { dlqId: entry.id, matchId: submission.matchId, gameId: submission.gameId },
    'oracle_dlq: retrying oracle submission',
  );

  try {
    if (!(await oracleTransport.hasResult(submission.matchId))) {
      // The worker already owns the durable job: failure must leave it queued,
      // rather than creating a second DLQ record or reporting success.
      await submitOracleResultToContract(submission);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { dlqId: entry.id, matchId: submission.matchId, error: message },
      'oracle_dlq: submission failed, entry will remain in DLQ',
    );
    throw err; // Re-throw so the entry stays in the DLQ
  }
}

async function main() {
  try {
    sqliteSettings();
    // Refuse to process queued work with an absent or unauthorized key.
    await signerProvider.getAuthorizedSigner();

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
      'oracle_pending_submissions_loaded',
    );

    // Start the retry worker
    const stopRetryWorker = startRetryWorker(retryOracleSubmission, 60_000);

    // Start the DLQ TTL eviction task (deletes entries older than DLQ_TTL_DAYS)
    const stopDlqEviction = startDlqEvictionTask();

    // Set up the polling worker with DLQ wiring for max-attempts exceeded
    const pollingStore = new PollingJobStore();
    const gamePoller = new ChessPlatformPoller();
    const pollingWorker = new PollingWorker(pollingStore, gamePoller, {
      pollingIntervalMs: parsePollingIntervalMs(
        process.env.POLLING_INTERVAL_MS,
      ),
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
        await writeToDlq({ job }, reason ?? 'max polling attempts exceeded');
      },
    });
    const stopPollingWorker = pollingWorker.start();

    // Start the Express server
    const server = app.listen(port, () => {
      logger.info({ port }, 'http_server_listening');
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
