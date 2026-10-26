/**
 * Dead-letter queue (DLQ) for failed oracle submissions.
 *
 * Failed submissions are stored via a pluggable persistent store (in-memory by
 * default; swap to SQLite or MongoDB via the QUEUE_STORE env var). A retry
 * worker periodically attempts to reprocess each entry and emits
 * `oracle_dlq_depth` for monitoring.
 *
 * Circuit breaker pattern protects against cascading RPC failures:
 * - After N consecutive failures, job processing is paused
 * - Backoff cooldown prevents hammering a degraded endpoint
 * - Automatic recovery testing after cooldown expires
 */

/* Import already at the top level */
import { getCircuitBreaker, CircuitState } from "./services/circuit-breaker.js";
import { InMemoryQueueStore } from "./store/in-memory-queue-store.js";
import { SQLiteQueueStore } from "./store/sqlite-queue-store.js";
import {
  currentTraceContext,
  newTraceContext,
  persistTraceContext,
  resumeTraceContext,
  runWithTraceContext,
  traceLogFields,
} from "./tracing/trace-context.js";
import type {
  DlqEntry,
  PersistentQueueStore,
} from "./store/persistent-queue-store.js";

export type { DlqEntry };

// Simple structured logger (avoids circular dependency on logger.ts)
// Carries the active trace ids like logger.ts does (#123).
const logger = {
  info: (context: object, message: string) =>
    console.log(
      JSON.stringify({
        level: "info",
        message,
        ...traceLogFields(),
        ...context,
      }),
    ),
  warn: (context: object, message: string) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        message,
        ...traceLogFields(),
        ...context,
      }),
    ),
  error: (context: object, message: string) =>
    console.error(
      JSON.stringify({
        level: "error",
        message,
        ...traceLogFields(),
        ...context,
      }),
    ),
};

let queueStore: PersistentQueueStore | null = null;

export type QueueStoreType = "memory" | "sqlite";

/**
 * Decide which queue store implementation to use for a given QUEUE_STORE
 * value and NODE_ENV, without touching disk. Exported for unit testing.
 *
 *   'sqlite' / 'auto' / unset → sqlite (durable; the default)
 *   'mongodb'                 → sqlite (mongoose is not an installed dependency)
 *   'memory'                  → memory, EXCEPT in production, where it is
 *                                auto-corrected to sqlite so DLQ entries
 *                                cannot silently be lost on restart.
 */
export function resolveQueueStoreType(
  rawQueueStore: string | undefined,
  nodeEnv: string | undefined,
): QueueStoreType {
  const requested = (rawQueueStore || "auto").toLowerCase();

  if (requested === "memory" && nodeEnv !== "production") {
    return "memory";
  }

  return "sqlite";
}

/**
 * Initialise the queue store based on the QUEUE_STORE environment variable.
 * Must be called once on application startup before any other queue function.
 *
 * See resolveQueueStoreType() for how QUEUE_STORE is resolved. In-memory
 * mode is never durable across restarts, so it always logs a warning, and
 * NODE_ENV=production silently requesting it is auto-corrected to SQLite
 * (see docs/oracle.md#queue-store-persistence).
 */
export async function initializeQueue(): Promise<void> {
  const rawQueueStore = process.env.QUEUE_STORE;
  const nodeEnv = process.env.NODE_ENV;
  const requested = (rawQueueStore || "auto").toLowerCase();
  const resolved = resolveQueueStoreType(rawQueueStore, nodeEnv);

  if (requested === "mongodb") {
    logger.warn(
      { requested },
      "oracle_dlq: QUEUE_STORE=mongodb requested but the mongoose dependency is not installed; falling back to sqlite",
    );
  }

  if (requested === "memory" && resolved === "sqlite") {
    logger.warn(
      { requested, nodeEnv },
      "oracle_dlq: QUEUE_STORE=memory is not safe in production (DLQ entries are lost on restart); auto-falling back to sqlite. See docs/oracle.md#queue-store-persistence.",
    );
  }

  queueStore =
    resolved === "memory" ? new InMemoryQueueStore() : new SQLiteQueueStore();

  await queueStore.initialize();

  if (resolved === "memory") {
    logger.warn(
      {},
      "oracle_dlq: using in-memory queue store -- DLQ entries will NOT survive a process restart. Not recommended outside local development; see docs/oracle.md#queue-store-persistence.",
    );
  }

  logger.info({ store: resolved }, "oracle_dlq: queue store initialized");
}

/**
 * Return the active queue store.
 * @throws if initializeQueue() has not been called yet.
 */
function getQueueStore(): PersistentQueueStore {
  if (!queueStore) {
    throw new Error(
      "Queue store not initialized. Call initializeQueue() first.",
    );
  }
  return queueStore;
}

/**
 * Write a failed submission to the DLQ.
 *
 * The active W3C trace context (#123) is stored with the entry so the retry
 * worker can resume the same trace, even after a restart. Work queued
 * outside any trace starts one here, so every entry is traceable.
 */
export async function writeToDlq(
  payload: unknown,
  failureReason: string,
): Promise<DlqEntry> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: DlqEntry = {
    id,
    payload,
    failureReason,
    attempts: 0,
    createdAt: Date.now(),
    lastAttemptAt: null,
    traceContext: persistTraceContext(
      currentTraceContext() ?? newTraceContext(),
    ),
  };

  await getQueueStore().add(entry);
  logger.warn({ dlqId: id, failureReason }, "oracle_dlq: entry written");
  await emitDlqDepth();
  return entry;
}

/** Return all pending DLQ entries (shallow copy). */
export async function listDlqEntries(): Promise<DlqEntry[]> {
  return await getQueueStore().getAll();
}

/** Remove a successfully processed entry. */
export async function removeDlqEntry(id: string): Promise<void> {
  await getQueueStore().remove(id);
  await emitDlqDepth();
}

/** Update an entry's retry state. */
export async function updateDlqEntry(
  id: string,
  updates: Partial<DlqEntry>,
): Promise<void> {
  await getQueueStore().update(id, updates);
}

/** Emit the oracle_dlq_depth metric. */
async function emitDlqDepth(): Promise<void> {
  const depth = await getQueueStore().count();
  logger.info({ metric: "oracle_dlq_depth", value: depth }, "oracle_dlq_depth");
}

export type RetryHandler = (entry: DlqEntry) => Promise<void>;

/**
 * Start the DLQ retry worker. Call once on startup.
 * Returns a cleanup function that stops the worker.
 *
 * Implements a circuit breaker to prevent cascading failures:
 * - Circuit opens after N consecutive RPC failures
 * - Job processing pauses during cooldown
 * - Exponential backoff for recovery attempts
 */
export function startRetryWorker(
  handler: RetryHandler,
  intervalMs = 60_000,
): () => void {
  const breaker = getCircuitBreaker();

  // Wrap the circuit breaker's state-change callback so we can log transitions
  const originalOnStateChange = breaker["config"].onStateChange;
  breaker["config"].onStateChange = (from: CircuitState, to: CircuitState) => {
    if (from !== to) {
      logger.warn(
        { from, to, ...breaker.getStatus() },
        "circuit_breaker: state changed",
      );
    }
    originalOnStateChange?.(from, to);
  };

  const timer = setInterval(async () => {
    const entries = await listDlqEntries();
    if (entries.length === 0) return;

    // Respect circuit breaker state
    if (!breaker.allowRequest()) {
      const remaining = breaker.getRemainingCooldown();
      logger.warn(
        { remaining, state: breaker.getState(), count: entries.length },
        "circuit_breaker: job processing paused",
      );
      return;
    }

    logger.info(
      { count: entries.length, state: breaker.getState() },
      "oracle_dlq: retry worker running",
    );

    try {
      for (const entry of entries) {
        // Each attempt is its own span under the trace the entry was queued
        // in (#123): its logs and outbound calls carry that trace id.
        const circuitOpened = await runWithTraceContext(
          resumeTraceContext(entry.traceContext),
          () => processEntry(entry),
        );
        // Stop processing remaining entries this cycle
        if (circuitOpened) break;
      }
    } catch (err) {
      logger.error({ err: String(err) }, "oracle_dlq: retry worker error");
    }
  }, intervalMs);

  /** Retry one entry. Returns true when this failure opened the circuit. */
  async function processEntry(entry: DlqEntry): Promise<boolean> {
    // Record the attempt before calling the handler
    entry.attempts += 1;
    entry.lastAttemptAt = Date.now();
    await updateDlqEntry(entry.id, {
      attempts: entry.attempts,
      lastAttemptAt: entry.lastAttemptAt,
    });

    try {
      await handler(entry);
      await removeDlqEntry(entry.id);
      breaker.recordSuccess();
      logger.info({ dlqId: entry.id }, "oracle_dlq: entry resolved");
    } catch (err) {
      const isRpcError =
        String(err).includes("RPC") || String(err).includes("Network");

      if (isRpcError) {
        const circuitOpened = breaker.recordFailure();
        if (circuitOpened) {
          logger.error(
            {
              dlqId: entry.id,
              attempt: entry.attempts,
              failureCount: breaker.getFailureCount(),
              cooldown: breaker.getRemainingCooldown(),
            },
            "circuit_breaker: RPC circuit opened, pausing job processing",
          );
          return true;
        }
      }

      logger.warn(
        {
          dlqId: entry.id,
          attempt: entry.attempts,
          isRpcError,
          err: String(err).substring(0, 100),
        },
        "oracle_dlq: retry failed",
      );
    }

    await emitDlqDepth();
    return false;
  }

  return () => {
    clearInterval(timer);
  };
}

/**
 * Shut down the queue store cleanly on application exit.
 */
export async function closeQueue(): Promise<void> {
  if (queueStore) {
    await queueStore.close();
    queueStore = null;
  }
}

const DEFAULT_DLQ_TTL_DAYS = 7;
const DEFAULT_DLQ_EVICTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Parse the DLQ_TTL_DAYS environment variable, falling back to the default
 * (7 days) when unset or invalid (non-numeric, zero, or negative).
 */
export function parseDlqTtlDays(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_DLQ_TTL_DAYS;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { rawValue },
      "oracle_dlq: invalid DLQ_TTL_DAYS, falling back to default of 7 days",
    );
    return DEFAULT_DLQ_TTL_DAYS;
  }

  return parsed;
}

/**
 * Delete DLQ entries older than the configured TTL (DLQ_TTL_DAYS, default 7
 * days). Logs the number of entries deleted. Returns that count.
 */
export async function evictExpiredDlqEntries(
  ttlDays: number = parseDlqTtlDays(process.env.DLQ_TTL_DAYS),
): Promise<number> {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const entries = await listDlqEntries();
  const expired = entries.filter((entry) => entry.createdAt < cutoff);

  for (const entry of expired) {
    await removeDlqEntry(entry.id);
  }

  logger.info(
    { deleted: expired.length, ttlDays },
    "oracle_dlq: TTL eviction run complete",
  );

  return expired.length;
}

/**
 * Start the periodic DLQ TTL eviction task. Call once on startup.
 * Returns a cleanup function that stops the task.
 */
export function startDlqEvictionTask(
  intervalMs = DEFAULT_DLQ_EVICTION_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    evictExpiredDlqEntries().catch((err) => {
      logger.error({ err: String(err) }, "oracle_dlq: TTL eviction run failed");
    });
  }, intervalMs);

  return () => clearInterval(timer);
}
