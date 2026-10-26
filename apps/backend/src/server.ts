import dotenv from "dotenv";
dotenv.config();

import { app } from "./app.js";
import { initializeQueue, closeQueue, startDlqEvictionTask } from "./queue.js";
import { SettlementStore } from "./store/settlement-store.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchStore, initializeMatchStore } from "./store/index.js";
import {
  initializeCircuitBreaker,
  closeCircuitBreakerStore,
} from "./services/circuit-breaker.js";
import {
  DurableOracleWorker,
  parsePollingIntervalMs,
} from "./services/polling.js";
import { SorobanSettlementClient } from "./services/oracle-submit.js";
import { createShutdownHandler } from "./shutdown.js";
import logger from "./logger.js";

const port = Number(process.env.PORT || 4000);

async function main() {
  try {
    // Initialize the persistent queue store
    await initializeQueue();
    logger.info("Queue store initialized");

    // Initialize the persistent match store (SQLite-backed)
    await initializeMatchStore();
    logger.info("Match store initialized");

    // Initialize the circuit breaker with SQLite-backed persistence (#1716),
    // restoring its prior state (or resetting to CLOSED if it went stale
    // while this process was down) before the retry worker starts using it.
    await initializeCircuitBreaker();
    logger.info("Circuit breaker initialized");

    const client = SorobanSettlementClient.fromEnvironment();
    const outbox = new SettlementStore(
      process.env.SETTLEMENT_DB_PATH ||
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "../data/settlements.db",
        ),
      `${client.config.networkPassphrase}:${client.config.escrowContract}`,
    );
    await outbox.initialize();
    const worker = new DurableOracleWorker(
      matchStore,
      outbox,
      client,
      parsePollingIntervalMs(process.env.POLLING_INTERVAL_MS),
    );
    app.locals.oracleWorker = worker;
    const stopPollingWorker = worker.start();
    // Legacy DLQ entries need manual review: they have no persisted signed
    // envelope/hash and cannot safely be blindly retried by the new pipeline.
    const stopDlqEviction = startDlqEvictionTask();

    // Start the Express server
    const server = app.listen(port, () => {
      logger.info(
        { port },
        `smile4money-backend listening on http://localhost:${port}`,
      );
    });

    // Graceful shutdown (#1719) — see shutdown.ts for the full sequencing
    // rationale (stop accepting new connections, drain in-flight work, close
    // stores, force-exit on timeout).
    const shutdown = createShutdownHandler({
      server,
      stopPollingWorker,
      stopRetryWorker: () => {},
      stopDlqEviction,
      closeQueue: async () => {
        await outbox.close();
        await matchStore.close();
        await closeQueue();
      },
      closeCircuitBreakerStore,
      logger,
      shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 30_000),
    });

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (error) {
    logger.error({ error }, "Failed to start server");
    process.exit(1);
  }
}

main();
