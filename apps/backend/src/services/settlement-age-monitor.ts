/**
 * Settlement Age Monitor
 *
 * Service-level observability for the path from match activation to a
 * confirmed on-chain settlement. A process can be perfectly healthy while
 * active matches silently wait too long for a game result or for the chain,
 * so this module records when each match reaches each stage and publishes
 * age percentiles and threshold alerts.
 *
 * Stages (the first timestamp recorded for a match wins):
 *   activated           the backend started tracking the match (polling job created)
 *   provider_result     the chess platform reported a final result
 *   submission_started  the first attempt to put the result on-chain began
 *   chain_confirmed     the result is confirmed on-chain, which settles the match
 *
 * Segments derived from the stages. They are kept separate on purpose so a
 * slow chess platform is never confused with a slow chain submission:
 *   provider_wait   activated          -> provider_result
 *   submission_lag  provider_result    -> submission_started
 *   chain_delay     submission_started -> chain_confirmed
 *   total           activated          -> chain_confirmed
 *
 * Published metrics: p50/p90/p95/p99/max for the most recent completed
 * matches and for matches that are still waiting in each segment.
 *
 * Alerts, per segment:
 *   <segment>_stuck     a waiting match is older than the segment threshold
 *   <segment>_slow_p95  the p95 of completed matches is above the threshold
 *
 * SAFETY: this module is observability only. It records timestamps, logs
 * metrics and calls an optional callback. It never changes what is submitted,
 * and it never reverses or settles anything.
 */

import logger from "../logger.js";

export type Stage =
  | "activated"
  | "provider_result"
  | "submission_started"
  | "chain_confirmed";
export type Segment =
  | "provider_wait"
  | "submission_lag"
  | "chain_delay"
  | "total";

export const SEGMENTS: readonly Segment[] = [
  "provider_wait",
  "submission_lag",
  "chain_delay",
  "total",
];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_CLOSED_IDS = 10_000;
const MAX_REPORTED_MATCH_IDS = 5;
const DEFAULT_PUBLISH_INTERVAL_MS = 60_000;

export interface SettlementAgeConfig {
  /** Alert when a match has waited this long (ms) for the chess platform result. */
  providerWaitMs: number;
  /** Alert when a finished game has waited this long (ms) for its submission to start. */
  submissionLagMs: number;
  /** Alert when a submission has waited this long (ms) for chain confirmation. */
  chainDelayMs: number;
  /** Alert when a match is older than this (ms) from activation without being settled. */
  totalMs: number;
  /** Number of most recent completed matches kept for percentiles. */
  completedWindow: number;
  /** Completed matches needed before a slow_p95 alert can fire. */
  minSamples: number;
  /** Maximum number of open matches tracked at once. */
  maxTracked: number;
}

export const DEFAULT_SETTLEMENT_AGE_CONFIG: SettlementAgeConfig = {
  providerWaitMs: 24 * HOUR_MS,
  submissionLagMs: 10 * MINUTE_MS,
  chainDelayMs: 15 * MINUTE_MS,
  totalMs: 48 * HOUR_MS,
  completedWindow: 200,
  minSamples: 5,
  maxTracked: 10_000,
};

export interface SegmentStats {
  count: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface OpenSegmentStats extends SegmentStats {
  /** Number of waiting matches older than the segment threshold. */
  overThreshold: number;
  /** Oldest matches over the threshold, to start an investigation from. */
  stuckMatchIds: number[];
}

export interface SettlementAlert {
  id: string;
  kind: "stuck" | "slow_p95";
  segment: Segment;
  thresholdMs: number;
  observedMs: number;
  count: number;
  matchIds: number[];
}

export interface SettlementSnapshot {
  generatedAt: number;
  openMatches: number;
  completedInWindow: number;
  abandoned: number;
  evicted: number;
  /** Durations (ms) of recently completed matches, per segment. */
  completed: Record<Segment, SegmentStats>;
  /** Ages (ms) of matches still waiting, per segment they are currently in. */
  open: Record<Segment, OpenSegmentStats>;
  alerts: SettlementAlert[];
  thresholds: SettlementAgeConfig;
}

export interface SettlementAgeOptions {
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Notified when an alert is raised. Observability only. */
  onAlert?: (alert: SettlementAlert) => void;
}

export interface ActiveJob {
  matchId: number;
  createdAt: number;
}

type IntervalFn = (fn: () => void, ms: number) => unknown;
type ClearIntervalFn = (handle: any) => void;

export interface PublisherOptions {
  intervalMs?: number;
  /** Jobs currently being polled. Their creation time is recorded as activation. */
  listActiveJobs?: () => ReadonlyArray<ActiveJob>;
  setIntervalFn?: IntervalFn;
  clearIntervalFn?: ClearIntervalFn;
}

interface Timeline {
  matchId: number;
  stages: Partial<Record<Stage, number>>;
}

interface AgeEntry {
  matchId: number;
  ageMs: number;
}

/** Nearest-rank percentile of an ascending array, or null when it is empty. */
export function percentile(
  sortedAscending: readonly number[],
  p: number,
): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index];
}

function summarize(values: readonly number[]): SegmentStats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1],
  };
}

function summarizeOpen(
  entries: readonly AgeEntry[],
  thresholdMs: number,
): OpenSegmentStats {
  const over = entries
    .filter((e) => e.ageMs > thresholdMs)
    .sort((a, b) => b.ageMs - a.ageMs);
  return {
    ...summarize(entries.map((e) => e.ageMs)),
    overThreshold: over.length,
    stuckMatchIds: over.slice(0, MAX_REPORTED_MATCH_IDS).map((e) => e.matchId),
  };
}

function emptyBuffers(): Record<Segment, number[]> {
  return { provider_wait: [], submission_lag: [], chain_delay: [], total: [] };
}

function emptyAges(): Record<Segment, AgeEntry[]> {
  return { provider_wait: [], submission_lag: [], chain_delay: [], total: [] };
}

function validateConfig(config: SettlementAgeConfig): void {
  const positive = (name: string, value: number) => {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Invalid ${name}: must be a positive number, got ${value}`,
      );
    }
  };
  const positiveInt = (name: string, value: number) => {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `Invalid ${name}: must be a positive integer, got ${value}`,
      );
    }
  };
  positive("providerWaitMs", config.providerWaitMs);
  positive("submissionLagMs", config.submissionLagMs);
  positive("chainDelayMs", config.chainDelayMs);
  positive("totalMs", config.totalMs);
  positiveInt("completedWindow", config.completedWindow);
  positiveInt("minSamples", config.minSamples);
  positiveInt("maxTracked", config.maxTracked);
  if (config.minSamples > config.completedWindow) {
    throw new Error("Invalid config: minSamples cannot exceed completedWindow");
  }
}

function readNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: "${raw}" is not a valid number`);
  }
  return parsed;
}

/**
 * Load thresholds from the environment, falling back to the defaults.
 * Invalid values throw so a misconfigured deployment fails loudly.
 *
 *   SETTLEMENT_AGE_PROVIDER_WAIT_MS     default 86400000 (24h)
 *   SETTLEMENT_AGE_SUBMISSION_LAG_MS    default 600000 (10m)
 *   SETTLEMENT_AGE_CHAIN_DELAY_MS       default 900000 (15m)
 *   SETTLEMENT_AGE_TOTAL_MS             default 172800000 (48h)
 *   SETTLEMENT_AGE_COMPLETED_WINDOW     default 200
 *   SETTLEMENT_AGE_MIN_SAMPLES          default 5
 *   SETTLEMENT_AGE_MAX_TRACKED          default 10000
 */
export function loadSettlementAgeConfig(
  env: Record<string, string | undefined> = process.env,
): SettlementAgeConfig {
  const d = DEFAULT_SETTLEMENT_AGE_CONFIG;
  const config: SettlementAgeConfig = {
    providerWaitMs: readNumber(
      env,
      "SETTLEMENT_AGE_PROVIDER_WAIT_MS",
      d.providerWaitMs,
    ),
    submissionLagMs: readNumber(
      env,
      "SETTLEMENT_AGE_SUBMISSION_LAG_MS",
      d.submissionLagMs,
    ),
    chainDelayMs: readNumber(
      env,
      "SETTLEMENT_AGE_CHAIN_DELAY_MS",
      d.chainDelayMs,
    ),
    totalMs: readNumber(env, "SETTLEMENT_AGE_TOTAL_MS", d.totalMs),
    completedWindow: readNumber(
      env,
      "SETTLEMENT_AGE_COMPLETED_WINDOW",
      d.completedWindow,
    ),
    minSamples: readNumber(env, "SETTLEMENT_AGE_MIN_SAMPLES", d.minSamples),
    maxTracked: readNumber(env, "SETTLEMENT_AGE_MAX_TRACKED", d.maxTracked),
  };
  validateConfig(config);
  return config;
}

/** How often metrics are published (SETTLEMENT_AGE_PUBLISH_INTERVAL_MS, default 60000). */
export function getSettlementPublishIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = readNumber(
    env,
    "SETTLEMENT_AGE_PUBLISH_INTERVAL_MS",
    DEFAULT_PUBLISH_INTERVAL_MS,
  );
  if (value <= 0) {
    throw new Error(
      `Invalid SETTLEMENT_AGE_PUBLISH_INTERVAL_MS: must be a positive number, got ${value}`,
    );
  }
  return value;
}

export class SettlementAgeMonitor {
  private readonly config: SettlementAgeConfig;
  private readonly now: () => number;
  private readonly onAlert?: (alert: SettlementAlert) => void;
  private readonly open = new Map<number, Timeline>();
  private readonly closed = new Set<number>();
  private readonly completed = emptyBuffers();
  private readonly activeAlerts = new Set<string>();
  private abandoned = 0;
  private evicted = 0;

  constructor(
    config: Partial<SettlementAgeConfig> = {},
    options: SettlementAgeOptions = {},
  ) {
    this.config = { ...DEFAULT_SETTLEMENT_AGE_CONFIG, ...config };
    validateConfig(this.config);
    this.now = options.now ?? Date.now;
    this.onAlert = options.onAlert;
  }

  /**
   * Record that a match reached a stage. The first timestamp for a stage wins,
   * so retries never move it. Recording chain_confirmed completes the match.
   * Matches that were already completed or abandoned are ignored.
   */
  recordStage(matchId: number, stage: Stage, at?: number): void {
    if (this.closed.has(matchId)) return;
    const timestamp = at !== undefined && Number.isFinite(at) ? at : this.now();

    let timeline = this.open.get(matchId);
    if (!timeline) {
      this.makeRoom();
      timeline = { matchId, stages: {} };
      this.open.set(matchId, timeline);
    }
    if (timeline.stages[stage] === undefined) {
      timeline.stages[stage] = timestamp;
    }
    if (stage === "chain_confirmed") {
      this.complete(timeline);
    }
  }

  /** Record activation for jobs that are being polled. Safe to call repeatedly. */
  syncActivations(jobs: ReadonlyArray<ActiveJob>): void {
    for (const job of jobs) {
      this.recordStage(job.matchId, "activated", job.createdAt);
    }
  }

  /** Stop tracking a match that will never settle (timed out, dead-lettered). */
  abandon(matchId: number, reason: string): void {
    if (!this.open.delete(matchId)) return;
    this.markClosed(matchId);
    this.abandoned += 1;
    logger.info(
      { match_id: matchId, reason },
      "settlement_age_match_abandoned",
    );
  }

  /** Read-only snapshot. Has no side effects. */
  getSnapshot(): SettlementSnapshot {
    const now = this.now();
    const ages = emptyAges();

    for (const timeline of this.open.values()) {
      const s = timeline.stages;
      let current: Segment;
      let since: number | undefined;
      if (s.submission_started !== undefined) {
        current = "chain_delay";
        since = s.submission_started;
      } else if (s.provider_result !== undefined) {
        current = "submission_lag";
        since = s.provider_result;
      } else {
        current = "provider_wait";
        since = s.activated;
      }
      if (since !== undefined) {
        ages[current].push({
          matchId: timeline.matchId,
          ageMs: Math.max(0, now - since),
        });
      }
      const start = s.activated ?? s.provider_result ?? s.submission_started;
      if (start !== undefined) {
        ages.total.push({
          matchId: timeline.matchId,
          ageMs: Math.max(0, now - start),
        });
      }
    }

    const completed = {} as Record<Segment, SegmentStats>;
    const open = {} as Record<Segment, OpenSegmentStats>;
    const alerts: SettlementAlert[] = [];

    for (const segment of SEGMENTS) {
      const thresholdMs = this.thresholdFor(segment);
      completed[segment] = summarize(this.completed[segment]);
      open[segment] = summarizeOpen(ages[segment], thresholdMs);

      const stuck = open[segment];
      if (stuck.overThreshold > 0 && stuck.max !== null) {
        alerts.push({
          id: `${segment}_stuck`,
          kind: "stuck",
          segment,
          thresholdMs,
          observedMs: stuck.max,
          count: stuck.overThreshold,
          matchIds: stuck.stuckMatchIds,
        });
      }

      const done = completed[segment];
      if (
        done.count >= this.config.minSamples &&
        done.p95 !== null &&
        done.p95 > thresholdMs
      ) {
        alerts.push({
          id: `${segment}_slow_p95`,
          kind: "slow_p95",
          segment,
          thresholdMs,
          observedMs: done.p95,
          count: done.count,
          matchIds: [],
        });
      }
    }

    return {
      generatedAt: now,
      openMatches: this.open.size,
      completedInWindow: this.completed.total.length,
      abandoned: this.abandoned,
      evicted: this.evicted,
      completed,
      open,
      alerts,
      thresholds: { ...this.config },
    };
  }

  /** Take a snapshot and log/notify once per alert transition (raised, cleared). */
  evaluate(): SettlementSnapshot {
    const snapshot = this.getSnapshot();
    const current = new Set(snapshot.alerts.map((a) => a.id));

    for (const alert of snapshot.alerts) {
      if (this.activeAlerts.has(alert.id)) continue;
      this.activeAlerts.add(alert.id);
      logger.error(
        { alert, action: "observability_only" },
        "settlement_age_alert_raised",
      );
      try {
        this.onAlert?.(alert);
      } catch {
        // A failing notifier must never affect the monitor.
      }
    }

    for (const id of [...this.activeAlerts]) {
      if (!current.has(id)) {
        this.activeAlerts.delete(id);
        logger.info({ alert_id: id }, "settlement_age_alert_cleared");
      }
    }

    return snapshot;
  }

  /** Evaluate alerts and publish the metrics as one structured log line. */
  publishNow(): SettlementSnapshot {
    const snapshot = this.evaluate();
    logger.info(
      { metric: "settlement_age", ...snapshot },
      "settlement_age_metrics",
    );
    return snapshot;
  }

  /**
   * Publish metrics immediately and then on an interval. The timer is unref'd
   * so it never keeps the process alive. Returns a function that stops it.
   */
  startPublisher(options: PublisherOptions = {}): () => void {
    const intervalMs = options.intervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS;
    const setIntervalFn: IntervalFn =
      options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    const clearIntervalFn: ClearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => clearInterval(handle as NodeJS.Timeout));

    const tick = () => {
      try {
        if (options.listActiveJobs) {
          this.syncActivations(options.listActiveJobs());
        }
        this.publishNow();
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "settlement_age_publish_failed",
        );
      }
    };

    tick();
    const timer = setIntervalFn(tick, intervalMs);
    (timer as { unref?: () => void } | undefined)?.unref?.();
    return () => clearIntervalFn(timer);
  }

  private thresholdFor(segment: Segment): number {
    switch (segment) {
      case "provider_wait":
        return this.config.providerWaitMs;
      case "submission_lag":
        return this.config.submissionLagMs;
      case "chain_delay":
        return this.config.chainDelayMs;
      case "total":
        return this.config.totalMs;
    }
  }

  private complete(timeline: Timeline): void {
    const s = timeline.stages;
    const span = (from?: number, to?: number): number | null =>
      from === undefined || to === undefined ? null : Math.max(0, to - from);
    const start = s.activated ?? s.provider_result ?? s.submission_started;
    const durations: Record<Segment, number | null> = {
      provider_wait: span(s.activated, s.provider_result),
      submission_lag: span(s.provider_result, s.submission_started),
      chain_delay: span(s.submission_started, s.chain_confirmed),
      total: span(start, s.chain_confirmed),
    };

    for (const segment of SEGMENTS) {
      const value = durations[segment];
      if (value === null) continue;
      const buffer = this.completed[segment];
      buffer.push(value);
      if (buffer.length > this.config.completedWindow) buffer.shift();
    }

    this.open.delete(timeline.matchId);
    this.markClosed(timeline.matchId);
  }

  private markClosed(matchId: number): void {
    this.closed.add(matchId);
    if (this.closed.size > MAX_CLOSED_IDS) {
      const oldest = this.closed.values().next().value;
      if (oldest !== undefined) this.closed.delete(oldest);
    }
  }

  private makeRoom(): void {
    while (this.open.size >= this.config.maxTracked) {
      const oldest = this.open.keys().next().value;
      if (oldest === undefined) return;
      this.open.delete(oldest);
      this.evicted += 1;
      if (this.evicted % 100 === 1) {
        logger.warn(
          { evicted: this.evicted, max_tracked: this.config.maxTracked },
          "settlement_age_tracking_limit_reached",
        );
      }
    }
  }
}

let activeMonitor: SettlementAgeMonitor | null = null;

export function getSettlementAgeMonitor(): SettlementAgeMonitor | null {
  return activeMonitor;
}

export function setSettlementAgeMonitor(
  monitor: SettlementAgeMonitor | null,
): void {
  activeMonitor = monitor;
}

/**
 * Build the monitor from environment variables and register it as the active
 * one. Returns null when SETTLEMENT_AGE_MONITOR_ENABLED=false. Invalid values
 * throw so a misconfigured deployment fails loudly.
 */
export function createSettlementAgeMonitorFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: SettlementAgeOptions = {},
): SettlementAgeMonitor | null {
  if (
    (env.SETTLEMENT_AGE_MONITOR_ENABLED ?? "true").trim().toLowerCase() ===
    "false"
  ) {
    logger.info({}, "settlement_age_monitor_disabled");
    setSettlementAgeMonitor(null);
    return null;
  }

  const config = loadSettlementAgeConfig(env);
  const monitor = new SettlementAgeMonitor(config, options);
  setSettlementAgeMonitor(monitor);
  logger.info({ config }, "settlement_age_monitor_enabled");
  return monitor;
}

/**
 * Wrap a submission handler so the monitor sees when submission starts and
 * when it is confirmed. A failure is rethrown untouched, so retry and
 * dead-letter behaviour does not change.
 */
export function trackSubmission<T extends { matchId: number }>(
  monitor: SettlementAgeMonitor | null,
  handler: (submission: T) => Promise<void>,
): (submission: T) => Promise<void> {
  if (!monitor) return handler;
  return async (submission: T) => {
    monitor.recordStage(submission.matchId, "submission_started");
    await handler(submission);
    monitor.recordStage(submission.matchId, "chain_confirmed");
  };
}

/**
 * Wrap an "already on-chain?" check so a result that is already confirmed
 * closes the match instead of leaving it open forever.
 */
export function trackExistence(
  monitor: SettlementAgeMonitor | null,
  checker: (matchId: number) => Promise<boolean>,
): (matchId: number) => Promise<boolean> {
  if (!monitor) return checker;
  return async (matchId: number) => {
    const exists = await checker(matchId);
    if (exists) monitor.recordStage(matchId, "chain_confirmed");
    return exists;
  };
}

export default SettlementAgeMonitor;
