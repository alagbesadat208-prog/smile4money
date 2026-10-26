/**
 * Game polling worker for monitoring chess games until completion.
 *
 * This worker:
 * 1. Monitors active matches waiting for game results
 * 2. Polls the chess platform API at configurable intervals
 * 3. Re-enqueues in-progress games with backoff
 * 4. Submits completed games to the oracle contract
 * 5. Handles errors with exponential backoff (retry/DLQ logic)
 *
 * Configuration:
 * - POLLING_INTERVAL_MS: Base polling interval (default 30s)
 * - MAX_POLLING_ATTEMPTS: Max retry attempts before DLQ (default 1440 = 12 hours)
 * - POLLING_BACKOFF_MULTIPLIER: Backoff multiplier for retries (default 1.0 = no backoff)
 */

import logger from '../logger.js';
import {
  currentTraceContext,
  newTraceContext,
  persistTraceContext,
  resumeTraceContext,
  runWithTraceContext,
  type PersistedTraceContext,
} from '../tracing/trace-context.js';
import type { MatchResult, GameResult } from '../fetchers/lichess.js';

/** Used when POLLING_INTERVAL_MS is unset. */
const DEFAULT_POLLING_INTERVAL_MS = 30_000;

/**
 * Parses and validates the POLLING_INTERVAL_MS environment variable (#34).
 *
 * Returns DEFAULT_POLLING_INTERVAL_MS when `rawValue` is undefined or empty
 * (the env var was not set). Throws a clear, actionable error for anything
 * else that isn't a finite, positive number — a non-numeric value, zero, or
 * a negative number would otherwise reach `setTimeout` as `NaN` or `<= 0`,
 * either firing immediately or looping the polling cycle far faster than
 * intended and hammering the chess-platform APIs. Callers (see server.ts)
 * are expected to let this throw during startup rather than catch it, so a
 * misconfigured deployment fails loudly instead of silently mis-polling.
 */
export function parsePollingIntervalMs(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.trim() === '') {
    return DEFAULT_POLLING_INTERVAL_MS;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Invalid POLLING_INTERVAL_MS: "${rawValue}" is not a valid number. ` +
        'Expected a positive integer number of milliseconds, e.g. 30000.',
    );
  }
  if (parsed <= 0) {
    throw new Error(
      `Invalid POLLING_INTERVAL_MS: ${parsed} must be greater than 0. ` +
        'Expected a positive integer number of milliseconds, e.g. 30000.',
    );
  }

  return parsed;
}

export interface PollJob {
  id: string;
  matchId: number;
  gameId: string;
  platform: 'lichess' | 'chessdotcom';
  username?: string; // Required for Chess.com
  pollingAttempt: number;
  createdAt: number;
  lastPolledAt: number | null;
  /**
   * Ledger height when the match went Active on-chain. Together with
   * `timeoutLedgers`, this bounds how long the job may keep polling before
   * the on-chain `timeout_ledgers` window makes a payout impossible (#51).
   * Undefined when the caller doesn't have (or doesn't want to enforce)
   * this — the worker then never times out the job on ledger height alone.
   */
  createdAtLedger?: number;
  /**
   * This match's `timeout_ledgers` window (the escrow contract allows this
   * to be configured per match at `create_match` time). Falls back to
   * `PollingConfig.defaultTimeoutLedgers` when not set.
   */
  timeoutLedgers?: number;
  /**
   * W3C trace context of the request that created the job (#123). Each poll
   * runs as a child span of it, and a job moved to the DLQ carries it on.
   */
  traceContext?: PersistedTraceContext;
}

export interface PollJobStatus {
  status: 'pending' | 'completed' | 'failed' | 'in_progress';
  result?: MatchResult;
  reason?: string;
}

export interface GamePoller {
  poll: (job: PollJob) => Promise<PollJobStatus>;
}

export interface PollingConfig {
  /** Base polling interval in milliseconds. Defaults to 30 000. */
  pollingIntervalMs?: number;
  /** Maximum polling attempts before the job is moved to DLQ. Defaults to 1440 (~12 h at 30 s intervals). */
  maxPollingAttempts?: number;
  /** Backoff multiplier applied to the interval on each retry. Defaults to 1.0 (no backoff). */
  backoffMultiplier?: number;
  /**
   * Default `timeout_ledgers` window (#51), used for a job that doesn't
   * carry its own `PollJob.timeoutLedgers`. Defaults to `TIMEOUT_LEDGERS`
   * from the escrow contract (~7 days at 5s/ledger — see
   * contracts/smile4money-common/src/constants.rs).
   */
  defaultTimeoutLedgers?: number;
  /**
   * Returns the current Soroban ledger sequence number. Injected (rather
   * than imported directly) so tests can control it without a real RPC
   * call — matches the same DI pattern as `GamePoller`. When omitted, the
   * ledger-timeout check in `pollJob` is skipped entirely (a job only ever
   * moves to DLQ via `maxPollingAttempts`, the pre-existing behavior).
   */
  getCurrentLedger?: () => Promise<number>;

  /**
   * Called when a game finishes and a result is available.
   * Use this to trigger oracle submission.
   *
   * @param job    - The polling job that completed
   * @param result - The game outcome reported by the chess platform
   */
  onGameCompleted: (job: PollJob, result: MatchResult) => Promise<void>;

  /**
   * Called when a polling job exceeds maxPollingAttempts.
   * Use this to write the job to a dead-letter queue and fire an alert.
   *
   * @param job    - The polling job that exhausted all attempts
   * @param reason - Optional failure reason from the last poll response
   */
  onMaxAttemptsExceeded: (job: PollJob, reason?: string) => Promise<void>;
}

/**
 * Calculate the delay for the next polling attempt using exponential backoff.
 *
 * Formula: baseInterval * (backoffMultiplier ^ attempt)
 * Examples:
 *   - No backoff (multiplier=1.0): always 30s
 *   - Linear backoff (multiplier=1.1): 30s, 33s, 36.3s, ...
 *   - Exponential backoff (multiplier=1.5): 30s, 45s, 67.5s, ...
 */
export function calculateNextPollDelay(
  attempt: number,
  baseIntervalMs: number,
  backoffMultiplier: number,
): number {
  return Math.round(baseIntervalMs * Math.pow(backoffMultiplier, attempt));
}

/**
 * Polling job store — tracks active polling jobs.
 * Swap the backing store (Map → Redis/DB) for persistence across restarts.
 */
export class PollingJobStore {
  private jobs = new Map<string, PollJob>();
  private matchIdToJobId = new Map<number, string>();
  private matchGameKeyToJobId = new Map<string, string>();

  private static matchGameKey(matchId: number, gameId: string): string {
    return `${matchId}::${gameId}`;
  }

  /**
   * Create a new polling job.
   *
   * Deduplicated on the (matchId, gameId) pair rather than matchId alone
   * (#46): if a cancelled match's matchId is later reused by a new match
   * (e.g. after a counter reset), the new match's game_id will differ from
   * the old one, so it must still be pollable as a distinct job instead of
   * being rejected as a duplicate of the cancelled match.
   *
   * @throws Error if a job already exists for this exact (matchId, gameId) pair
   */
  createJob(
    matchId: number,
    gameId: string,
    platform: 'lichess' | 'chessdotcom',
    username?: string,
    createdAtLedger?: number,
    timeoutLedgers?: number,
  ): PollJob {
    const key = PollingJobStore.matchGameKey(matchId, gameId);
    if (this.matchGameKeyToJobId.has(key)) {
      throw new Error(
        `Polling job already exists for match ${matchId} (game ${gameId})`,
      );
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job: PollJob = {
      id,
      matchId,
      gameId,
      platform,
      username,
      pollingAttempt: 0,
      createdAt: Date.now(),
      lastPolledAt: null,
      createdAtLedger,
      timeoutLedgers,
      traceContext: persistTraceContext(currentTraceContext() ?? newTraceContext()),
    };

    this.jobs.set(id, job);
    // Tracks the (most recently created) job for a bare matchId lookup —
    // in the common case there is only ever one active job per match, but
    // this must not be the dedup key itself (see matchGameKeyToJobId above).
    this.matchIdToJobId.set(matchId, id);
    this.matchGameKeyToJobId.set(key, id);

    logger.info(
      { match_id: matchId, game_id: gameId, platform },
      'polling_job_created',
    );

    return job;
  }

  /**
   * Get a polling job by ID.
   */
  getJob(jobId: string): PollJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  /**
   * Get the polling job for a match ID.
   */
  getJobByMatchId(matchId: number): PollJob | null {
    const jobId = this.matchIdToJobId.get(matchId);
    return jobId ? this.jobs.get(jobId) ?? null : null;
  }

  /**
   * List all pending polling jobs.
   */
  listPendingJobs(): PollJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Increment the polling attempt counter.
   */
  incrementAttempt(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.pollingAttempt += 1;
      job.lastPolledAt = Date.now();
    }
  }

  /**
   * Complete and remove a polling job.
   */
  completeJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      this.removeJobIndexes(job);
      this.jobs.delete(jobId);
      logger.info(
        { match_id: job.matchId, polling_attempts: job.pollingAttempt },
        'polling_job_completed',
      );
    }
  }

  /**
   * Remove a polling job (e.g., when moved to DLQ).
   */
  removeJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      this.removeJobIndexes(job);
      this.jobs.delete(jobId);
    }
  }

  /**
   * Clear this job's entries from the lookup indexes, but only if they
   * still point at this job — with (matchId, gameId) dedup (#46), a second
   * job can share a matchId with this one, and completing/removing this job
   * must not clobber the other job's still-valid matchId lookup entry.
   */
  private removeJobIndexes(job: PollJob): void {
    const key = PollingJobStore.matchGameKey(job.matchId, job.gameId);
    if (this.matchGameKeyToJobId.get(key) === job.id) {
      this.matchGameKeyToJobId.delete(key);
    }
    if (this.matchIdToJobId.get(job.matchId) === job.id) {
      this.matchIdToJobId.delete(job.matchId);
    }
  }

  /**
   * Clear all jobs (for testing).
   */
  clear(): void {
    this.jobs.clear();
    this.matchIdToJobId.clear();
    this.matchGameKeyToJobId.clear();
  }
}

/**
 * Polling worker that periodically polls chess games and re-enqueues as needed.
 *
 * Usage:
 *   const store = new PollingJobStore();
 *   const worker = new PollingWorker(store, gamePoller, config);
 *   const cleanup = worker.start();
 *   // Later, e.g. on SIGTERM...
 *   await cleanup(); // waits for any in-flight poll to finish (#1719)
 */
/** Matches contracts/smile4money-common/src/constants.rs's TIMEOUT_LEDGERS (~7 days at 5s/ledger). */
const DEFAULT_TIMEOUT_LEDGERS = 120_960;

/** `getCurrentLedger` stays optional even once the rest of the config is defaulted. */
type ResolvedPollingConfig = Required<Omit<PollingConfig, 'getCurrentLedger'>> &
  Pick<PollingConfig, 'getCurrentLedger'>;

export class PollingWorker {
  private store: PollingJobStore;
  private poller: GamePoller;
  private config: ResolvedPollingConfig;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  /**
   * Poll operations (a full cycle or a single re-polled job) currently in
   * flight, i.e. their network call to the chess-platform API has started
   * but not yet resolved. `stop()` awaits these instead of abandoning them
   * mid-request (#1719).
   */
  private inFlight: Set<Promise<void>> = new Set();
  /**
   * Set by `stop()`. Checked before arming any new timer or starting any new
   * poll cycle, so work already in flight when shutdown begins is allowed to
   * finish, but nothing new starts afterward — the polling-queue equivalent
   * of `server.close()` refusing new connections while draining existing
   * ones (#1719).
   */
  private stopped = false;

  constructor(
    store: PollingJobStore,
    poller: GamePoller,
    config: PollingConfig,
  ) {
    this.store = store;
    this.poller = poller;
    this.config = {
      pollingIntervalMs: config.pollingIntervalMs ?? 30_000,
      maxPollingAttempts: config.maxPollingAttempts ?? 1440, // ~12 hours at 30s intervals
      backoffMultiplier: config.backoffMultiplier ?? 1.0, // No backoff by default
      defaultTimeoutLedgers: config.defaultTimeoutLedgers ?? DEFAULT_TIMEOUT_LEDGERS,
      getCurrentLedger: config.getCurrentLedger,
      onGameCompleted: config.onGameCompleted,
      onMaxAttemptsExceeded: config.onMaxAttemptsExceeded,
    };
  }

  /**
   * Registers `promise` as in-flight until it settles, so `stop()` can await
   * it. Errors are not swallowed here — callers already attach their own
   * `.catch`/try-catch for logging; this only tracks lifetime.
   */
  private track(promise: Promise<void>): Promise<void> {
    const tracked = promise.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
    return tracked;
  }

  /**
   * Start the polling worker.
   * Immediately polls all pending jobs, then sets up periodic polling.
   *
   * @returns A cleanup function that stops the worker and waits for any
   *   in-flight poll to finish (#1719)
   */
  start(): () => Promise<void> {
    logger.info(
      {
        interval_ms: this.config.pollingIntervalMs,
        max_attempts: this.config.maxPollingAttempts,
        backoff: this.config.backoffMultiplier,
      },
      'polling_worker_started',
    );

    // Trigger first poll immediately
    this.track(this.pollAllJobs());

    return () => this.stop();
  }

  /**
   * Stop the worker: clear every pending timer (nothing that hasn't started
   * yet will start), then wait for any poll cycle or per-job re-poll that
   * was already running to finish before resolving (#1719). This is the
   * "drain" half of graceful shutdown for the polling queue — in-flight
   * chess-platform API calls and their DB writes are allowed to complete
   * rather than being abandoned mid-request.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    await Promise.allSettled([...this.inFlight]);

    logger.info({}, 'polling_worker_stopped');
  }

  /**
   * Poll all pending jobs immediately.
   */
  private async pollAllJobs(): Promise<void> {
    const jobs = this.store.listPendingJobs();

    if (jobs.length === 0) {
      // Re-schedule the next polling cycle, unless shutdown has started
      // (#1719) — a cycle that finds nothing to do must not arm a timer
      // that would fire after stop() has already returned.
      if (!this.stopped) this.scheduleNextPoll();
      return;
    }

    logger.info(
      { count: jobs.length },
      'polling_worker_polling_all_jobs',
    );

    for (const job of jobs) {
      try {
        // Each poll is a span in the trace that created the job (#123).
        await runWithTraceContext(resumeTraceContext(job.traceContext), () => this.pollJob(job));
      } catch (err) {
        logger.error(
          {
            match_id: job.matchId,
            game_id: job.gameId,
            attempt: job.pollingAttempt,
            error: err instanceof Error ? err.message : String(err),
          },
          'polling_job_error',
        );
      }
    }

    // Re-schedule the next polling cycle, unless shutdown has started (#1719).
    if (!this.stopped) this.scheduleNextPoll();
  }

  /**
   * Checks whether `job` has exceeded its on-chain `timeout_ledgers` window
   * and, if so, moves it to DLQ with reason `TIMED_OUT` (#51).
   *
   * Fails open: if the ledger-height fetch itself fails (RPC unreachable,
   * misconfigured), this logs a warning and returns `false` so the job is
   * still polled normally this cycle rather than blocking on an
   * unavailable dependency.
   *
   * @returns true if the job was timed out and moved to DLQ (the caller
   *   must not continue processing this job this cycle)
   */
  private async checkLedgerTimeout(job: PollJob): Promise<boolean> {
    const createdAtLedger = job.createdAtLedger;
    if (createdAtLedger === undefined || !this.config.getCurrentLedger) {
      return false;
    }

    const timeoutLedgers = job.timeoutLedgers ?? this.config.defaultTimeoutLedgers;

    let currentLedger: number;
    try {
      currentLedger = await this.config.getCurrentLedger();
    } catch (err) {
      logger.warn(
        {
          match_id: job.matchId,
          game_id: job.gameId,
          error: err instanceof Error ? err.message : String(err),
        },
        'polling_job_ledger_fetch_failed',
      );
      return false;
    }

    if (currentLedger < createdAtLedger + timeoutLedgers) {
      return false;
    }

    logger.error(
      {
        match_id: job.matchId,
        game_id: job.gameId,
        created_at_ledger: createdAtLedger,
        timeout_ledgers: timeoutLedgers,
        current_ledger: currentLedger,
        ledgers_elapsed: currentLedger - createdAtLedger,
      },
      'polling_job_timed_out_moving_to_dlq',
    );

    this.store.removeJob(job.id);

    try {
      await this.config.onMaxAttemptsExceeded(job, 'TIMED_OUT');
    } catch (callbackErr) {
      logger.error(
        {
          match_id: job.matchId,
          game_id: job.gameId,
          error: callbackErr instanceof Error ? callbackErr.message : String(callbackErr),
        },
        'polling_job_on_max_attempts_callback_failed',
      );
    }

    return true;
  }

  /**
   * Poll a single job and handle the result.
   *
   * - If the match has been Active longer than its on-chain timeout_ledgers
   *   window: stop polling and move to DLQ with reason TIMED_OUT (#51) —
   *   no further payout is possible past that point, so continuing to poll
   *   would be wasted work.
   * - If game is in progress: increment attempt, re-schedule this specific job
   * - If game is completed: call handler and remove job
   * - If error: increment attempt, check max attempts
   */
  private async pollJob(job: PollJob): Promise<void> {
    if (job.createdAtLedger !== undefined && this.config.getCurrentLedger) {
      const timedOut = await this.checkLedgerTimeout(job);
      if (timedOut) return;
    }

    this.store.incrementAttempt(job.id);

    const status = await this.poller.poll(job);

    if (status.status === 'in_progress') {
      // Game still in progress — re-enqueue with backoff
      const nextDelay = calculateNextPollDelay(
        job.pollingAttempt,
        this.config.pollingIntervalMs,
        this.config.backoffMultiplier,
      );

      logger.info(
        {
          match_id: job.matchId,
          game_id: job.gameId,
          attempt: job.pollingAttempt,
          next_poll_ms: nextDelay,
        },
        'polling_job_game_in_progress_re_enqueuing',
      );

      // Schedule next poll for this specific job, unless shutdown has
      // started (#1719) — this timer callback fires later, asynchronously,
      // so it must re-check `this.stopped` itself rather than trust the
      // state at the moment it was armed.
      const timer = setTimeout(() => {
        if (this.stopped) return;
        this.track(
          this.pollJob(job).catch((err) => {
            logger.error(
              {
                match_id: job.matchId,
                game_id: job.gameId,
                error: err instanceof Error ? err.message : String(err),
              },
              'polling_job_requeue_failed',
            );
          }),
        );
      }, nextDelay);

      this.timers.set(job.id, timer);
    } else if (status.status === 'completed' && status.result) {
      // Game completed — remove from polling and invoke the completion handler
      logger.info(
        {
          match_id: job.matchId,
          game_id: job.gameId,
          result: status.result,
          polling_attempts: job.pollingAttempt,
        },
        'polling_job_game_completed',
      );

      this.store.completeJob(job.id);

      try {
        await this.config.onGameCompleted(job, status.result);
      } catch (callbackErr) {
        logger.error(
          {
            match_id: job.matchId,
            game_id: job.gameId,
            result: status.result,
            error:
              callbackErr instanceof Error
                ? callbackErr.message
                : String(callbackErr),
          },
          'polling_job_on_game_completed_callback_failed',
        );
      }
    } else if (status.status === 'failed') {
      // Polling failed — check if we should retry or move to DLQ
      if (job.pollingAttempt >= this.config.maxPollingAttempts) {
        logger.error(
          {
            match_id: job.matchId,
            game_id: job.gameId,
            attempt: job.pollingAttempt,
            max_attempts: this.config.maxPollingAttempts,
            reason: status.reason,
          },
          'polling_job_max_attempts_exceeded_moving_to_dlq',
        );

        this.store.removeJob(job.id);

        try {
          await this.config.onMaxAttemptsExceeded(job, status.reason);
        } catch (callbackErr) {
          logger.error(
            {
              match_id: job.matchId,
              game_id: job.gameId,
              error:
                callbackErr instanceof Error
                  ? callbackErr.message
                  : String(callbackErr),
            },
            'polling_job_on_max_attempts_callback_failed',
          );
        }
      } else {
        logger.warn(
          {
            match_id: job.matchId,
            game_id: job.gameId,
            attempt: job.pollingAttempt,
            max_attempts: this.config.maxPollingAttempts,
            reason: status.reason,
          },
          'polling_job_failed_will_retry',
        );

        // Will be retried in the next polling cycle
      }
    }
  }

  /**
   * Schedule the next full polling cycle.
   */
  private scheduleNextPoll(): void {
    const timer = setTimeout(() => {
      if (this.stopped) return;
      this.track(
        this.pollAllJobs().catch((err) => {
          logger.error(
            {
              error: err instanceof Error ? err.message : String(err),
            },
            'polling_worker_cycle_error',
          );
        }),
      );
    }, this.config.pollingIntervalMs);

    // Use a fixed key so we don't accumulate timers
    const oldTimer = this.timers.get('__cycle__');
    if (oldTimer) clearTimeout(oldTimer);
    this.timers.set('__cycle__', timer);
  }
}

export default {
  PollingJobStore,
  PollingWorker,
  calculateNextPollDelay,
  parsePollingIntervalMs,
};
