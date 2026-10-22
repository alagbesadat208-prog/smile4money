/**
 * Graceful shutdown orchestration (#1719).
 *
 * Extracted out of server.ts so the sequencing — stop accepting new
 * connections, drain in-flight work, close stores, force-exit on timeout —
 * can be exercised directly in a test against a real HTTP server, without
 * pulling in the whole application (real match/queue stores, the chess
 * platform poller, etc.) or sending actual OS signals to the test process.
 */

export interface ShutdownDeps {
  /** The HTTP server to stop accepting new connections on. */
  server: { close: (callback: (err?: Error) => void) => void };
  /** Drains the polling queue: waits for any in-flight poll to finish. */
  stopPollingWorker: () => Promise<void>;
  stopOutboxDispatcher?: () => void | Promise<void>;
  /** Stops the DLQ retry worker's interval. Synchronous — no drain needed. */
  stopRetryWorker: () => void;
  /** Stops the DLQ TTL eviction task's interval. */
  stopDlqEviction: () => void;
  /** Closes the persistent queue store's DB handle. */
  closeQueue: () => Promise<void>;
  closeMatchStore?: () => Promise<void>;
  /** Closes the circuit breaker's persistence store DB handle. */
  closeCircuitBreakerStore: () => Promise<void>;
  logger: {
    info: (context: object, message: string) => void;
    error: (context: object, message: string) => void;
  };
  /** Force-exit watchdog, in ms. Default 30_000 (#1719 acceptance criteria). */
  shutdownTimeoutMs?: number;
  /** Injectable so tests can assert on the exit code without killing the test process. */
  exit?: (code: number) => void;
  /** Injectable timer functions, so tests can use fake timers if desired. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Builds a signal handler that performs an idempotent graceful shutdown:
 *
 * 1. `server.close()` immediately stops accepting *new* connections but lets
 *    in-flight HTTP requests finish — its callback fires only once every
 *    connection has closed. Run concurrently with (2) rather than before it,
 *    since neither depends on the other and both should start draining as
 *    soon as the signal is received.
 * 2. The polling worker, retry worker, and DLQ eviction task are stopped.
 *    The polling worker's stop() drains (awaits any in-flight poll); the
 *    other two are plain interval stops with nothing to drain.
 * 3. Once both of the above have settled, the queue store and circuit
 *    breaker store are closed — after, not concurrently with, anything that
 *    might still write through them.
 *
 * A watchdog timer force-exits with code 1 if the whole sequence takes
 * longer than `shutdownTimeoutMs`, so a connection that never closes (e.g. a
 * client holding a keep-alive socket open) cannot hang the process forever.
 *
 * Calling the returned handler more than once is a no-op after the first
 * call — a process can receive both SIGTERM and SIGINT in close succession.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 30_000;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  let isShuttingDown = false;

  return async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    deps.logger.info({ signal }, 'Shutting down gracefully...');

    const forceExitTimer = setTimeoutFn(() => {
      deps.logger.error(
        { timeout_ms: shutdownTimeoutMs },
        'Graceful shutdown timed out, forcing exit',
      );
      exit(1);
    }, shutdownTimeoutMs);
    forceExitTimer.unref?.();

    try {
      const closeServer = new Promise<void>((resolve, reject) => {
        deps.server.close((err) => (err ? reject(err) : resolve()));
      });

      await Promise.all([
        closeServer,
        deps.stopPollingWorker(),
        Promise.resolve(deps.stopRetryWorker()),
        Promise.resolve(deps.stopDlqEviction()),
        Promise.resolve(deps.stopOutboxDispatcher?.()),
      ]);

      await Promise.all([deps.closeQueue(), deps.closeCircuitBreakerStore(), deps.closeMatchStore?.()]);

      deps.logger.info({}, 'Server closed');
      clearTimeoutFn(forceExitTimer);
      exit(0);
    } catch (err) {
      deps.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Error during graceful shutdown',
      );
      clearTimeoutFn(forceExitTimer);
      exit(1);
    }
  };
}
