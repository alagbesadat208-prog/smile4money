import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import logger from "../../src/logger.js";
import {
  DEFAULT_SETTLEMENT_AGE_CONFIG,
  SettlementAgeMonitor,
  createSettlementAgeMonitorFromEnv,
  getSettlementAgeMonitor,
  getSettlementPublishIntervalMs,
  loadSettlementAgeConfig,
  percentile,
  setSettlementAgeMonitor,
  trackExistence,
  trackSubmission,
} from "../../src/services/settlement-age-monitor.js";
import type {
  SettlementAgeConfig,
  SettlementAgeOptions,
} from "../../src/services/settlement-age-monitor.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_700_000_000_000;

function setup(
  config: Partial<SettlementAgeConfig> = {},
  options: SettlementAgeOptions = {},
) {
  const clock = { now: T0 };
  const monitor = new SettlementAgeMonitor(config, {
    now: () => clock.now,
    ...options,
  });
  return { monitor, clock };
}

function settle(
  monitor: SettlementAgeMonitor,
  matchId: number,
  base: number,
  gaps: { providerWait: number; submissionLag: number; chainDelay: number },
) {
  const providerAt = base + gaps.providerWait;
  const submittedAt = providerAt + gaps.submissionLag;
  monitor.recordStage(matchId, "activated", base);
  monitor.recordStage(matchId, "provider_result", providerAt);
  monitor.recordStage(matchId, "submission_started", submittedAt);
  monitor.recordStage(
    matchId,
    "chain_confirmed",
    submittedAt + gaps.chainDelay,
  );
}

function alertIds(monitor: SettlementAgeMonitor): string[] {
  return monitor
    .getSnapshot()
    .alerts.map((a) => a.id)
    .sort();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setSettlementAgeMonitor(null);
});

describe("percentile", () => {
  it("returns null for an empty array", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("uses nearest-rank on a known set", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 90)).toBe(90);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
  });

  it("returns the only value for a single-element array", () => {
    expect(percentile([7], 1)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
  });
});

describe("segments distinguish provider wait from chain submission delay", () => {
  it("attributes a slow chess platform to provider_wait only", () => {
    const { monitor } = setup({ providerWaitMs: HOUR });
    for (let id = 1; id <= 5; id += 1) {
      settle(monitor, id, T0, {
        providerWait: 4 * HOUR,
        submissionLag: 1_000,
        chainDelay: 30_000,
      });
    }

    const { completed } = monitor.getSnapshot();
    expect(completed.provider_wait.p50).toBe(4 * HOUR);
    expect(completed.provider_wait.p95).toBe(4 * HOUR);
    expect(completed.submission_lag.p50).toBe(1_000);
    expect(completed.chain_delay.p50).toBe(30_000);
    expect(completed.total.p50).toBe(4 * HOUR + 31_000);

    const ids = alertIds(monitor);
    expect(ids).toContain("provider_wait_slow_p95");
    expect(ids).not.toContain("chain_delay_slow_p95");
    expect(ids).not.toContain("submission_lag_slow_p95");
  });

  it("attributes a slow chain to chain_delay only", () => {
    const { monitor } = setup();
    for (let id = 1; id <= 5; id += 1) {
      settle(monitor, id, T0, {
        providerWait: MIN,
        submissionLag: 2_000,
        chainDelay: 2 * HOUR,
      });
    }

    const { completed } = monitor.getSnapshot();
    expect(completed.provider_wait.p95).toBe(MIN);
    expect(completed.chain_delay.p95).toBe(2 * HOUR);

    const ids = alertIds(monitor);
    expect(ids).toContain("chain_delay_slow_p95");
    expect(ids).not.toContain("provider_wait_slow_p95");
  });

  it("raises only provider_wait_stuck for a match still waiting on the provider", () => {
    const { monitor, clock } = setup();
    monitor.recordStage(1, "activated", T0);
    clock.now = T0 + 25 * HOUR;

    expect(alertIds(monitor)).toEqual(["provider_wait_stuck"]);
  });

  it("raises only chain_delay_stuck for a match whose submission is not confirmed", () => {
    const { monitor, clock } = setup();
    monitor.recordStage(1, "activated", T0);
    monitor.recordStage(1, "provider_result", T0 + MIN);
    monitor.recordStage(1, "submission_started", T0 + 2 * MIN);
    clock.now = T0 + 2 * HOUR;

    expect(alertIds(monitor)).toEqual(["chain_delay_stuck"]);
  });

  it("raises only submission_lag_stuck for a finished game that never started submitting", () => {
    const { monitor, clock } = setup();
    monitor.recordStage(1, "activated", T0);
    monitor.recordStage(1, "provider_result", T0 + MIN);
    clock.now = T0 + MIN + 11 * MIN;

    expect(alertIds(monitor)).toEqual(["submission_lag_stuck"]);
  });

  it("raises total_stuck once a match is older than the overall threshold", () => {
    const { monitor, clock } = setup();
    monitor.recordStage(1, "activated", T0);
    clock.now = T0 + 49 * HOUR;

    expect(alertIds(monitor)).toEqual(["provider_wait_stuck", "total_stuck"]);
  });
});

describe("percentiles for open matches", () => {
  it("reports age percentiles for matches waiting on the provider", () => {
    const { monitor, clock } = setup();
    for (let i = 0; i < 5; i += 1) {
      monitor.recordStage(i + 1, "activated", T0 + i * MIN);
    }
    clock.now = T0 + 100 * MIN;

    const { open } = monitor.getSnapshot();
    expect(open.provider_wait.count).toBe(5);
    expect(open.provider_wait.p50).toBe(98 * MIN);
    expect(open.provider_wait.p95).toBe(100 * MIN);
    expect(open.provider_wait.max).toBe(100 * MIN);
    expect(open.total.count).toBe(5);
    expect(open.chain_delay.count).toBe(0);
    expect(open.chain_delay.p50).toBeNull();
  });

  it("lists the oldest stuck matches first and caps the list", () => {
    const { monitor, clock } = setup({ providerWaitMs: MIN });
    for (let id = 1; id <= 8; id += 1) {
      monitor.recordStage(id, "activated", T0 + id * 1000);
    }
    clock.now = T0 + HOUR;

    const stuck = monitor.getSnapshot().open.provider_wait;
    expect(stuck.overThreshold).toBe(8);
    expect(stuck.stuckMatchIds).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("slow p95 alerts", () => {
  it("needs the minimum number of completed samples", () => {
    const { monitor } = setup();
    const gaps = { providerWait: MIN, submissionLag: 1_000, chainDelay: HOUR };
    for (let id = 1; id <= 4; id += 1) settle(monitor, id, T0, gaps);
    expect(alertIds(monitor)).not.toContain("chain_delay_slow_p95");

    settle(monitor, 5, T0, gaps);
    const alert = monitor
      .getSnapshot()
      .alerts.find((a) => a.id === "chain_delay_slow_p95");
    expect(alert).toMatchObject({
      kind: "slow_p95",
      observedMs: HOUR,
      count: 5,
    });
  });

  it("keeps only the most recent completed matches", () => {
    const { monitor } = setup({ completedWindow: 5, minSamples: 5 });
    for (let id = 1; id <= 5; id += 1) {
      settle(monitor, id, T0, {
        providerWait: MIN,
        submissionLag: 1_000,
        chainDelay: 2 * HOUR,
      });
    }
    for (let id = 6; id <= 10; id += 1) {
      settle(monitor, id, T0, {
        providerWait: MIN,
        submissionLag: 1_000,
        chainDelay: 1_000,
      });
    }

    const snapshot = monitor.getSnapshot();
    expect(snapshot.completedInWindow).toBe(5);
    expect(snapshot.completed.chain_delay.p95).toBe(1_000);
    expect(snapshot.alerts).toEqual([]);
  });
});

describe("alert transitions", () => {
  it("logs and notifies once when raised, and logs when cleared", () => {
    const onAlert = vi.fn();
    const { monitor, clock } = setup({}, { onAlert });
    monitor.recordStage(1, "activated", T0);
    clock.now = T0 + 25 * HOUR;

    monitor.evaluate();
    monitor.evaluate();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ action: "observability_only" }),
      "settlement_age_alert_raised",
    );
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "provider_wait_stuck" }),
    );

    monitor.recordStage(1, "provider_result");
    monitor.recordStage(1, "submission_started");
    monitor.recordStage(1, "chain_confirmed");
    monitor.evaluate();

    expect(logger.info).toHaveBeenCalledWith(
      { alert_id: "provider_wait_stuck" },
      "settlement_age_alert_cleared",
    );
  });

  it("raises the alert again after it cleared", () => {
    const onAlert = vi.fn();
    const { monitor, clock } = setup({}, { onAlert });
    monitor.recordStage(1, "activated", T0);
    clock.now = T0 + 25 * HOUR;
    monitor.evaluate();
    monitor.abandon(1, "TIMED_OUT");
    monitor.evaluate();

    monitor.recordStage(2, "activated", clock.now - 25 * HOUR);
    monitor.evaluate();

    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  it("keeps working when the notifier throws", () => {
    const onAlert = vi.fn(() => {
      throw new Error("pager down");
    });
    const { monitor, clock } = setup({}, { onAlert });
    monitor.recordStage(1, "activated", T0);
    clock.now = T0 + 25 * HOUR;

    expect(() => monitor.evaluate()).not.toThrow();
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it("getSnapshot has no side effects", () => {
    const onAlert = vi.fn();
    const { monitor, clock } = setup({}, { onAlert });
    monitor.recordStage(1, "activated", T0);
    clock.now = T0 + 25 * HOUR;
    vi.clearAllMocks();

    monitor.getSnapshot();
    monitor.getSnapshot();

    expect(onAlert).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe("stage recording rules", () => {
  it("keeps the first timestamp for a stage", () => {
    const { monitor, clock } = setup();
    monitor.recordStage(1, "activated", T0);
    monitor.recordStage(1, "activated", T0 + 999 * MIN);
    clock.now = T0 + 10 * MIN;

    expect(monitor.getSnapshot().open.provider_wait.max).toBe(10 * MIN);
  });

  it("clamps negative durations from out-of-order timestamps to zero", () => {
    const { monitor } = setup();
    monitor.recordStage(1, "activated", T0 + 10 * MIN);
    monitor.recordStage(1, "provider_result", T0);
    monitor.recordStage(1, "submission_started", T0 + MIN);
    monitor.recordStage(1, "chain_confirmed", T0 + 2 * MIN);

    const { completed } = monitor.getSnapshot();
    expect(completed.provider_wait.p50).toBe(0);
    expect(completed.submission_lag.p50).toBe(MIN);
    expect(completed.chain_delay.p50).toBe(MIN);
    expect(completed.total.p50).toBe(0);
  });

  it("ignores a match after it completed", () => {
    const { monitor } = setup();
    settle(monitor, 1, T0, {
      providerWait: MIN,
      submissionLag: 1_000,
      chainDelay: 1_000,
    });
    monitor.recordStage(1, "activated", T0);
    monitor.recordStage(1, "provider_result", T0);

    const snapshot = monitor.getSnapshot();
    expect(snapshot.openMatches).toBe(0);
    expect(snapshot.completedInWindow).toBe(1);
  });

  it("handles a match that skipped earlier stages", () => {
    const { monitor, clock } = setup();
    monitor.recordStage(1, "submission_started", T0);
    clock.now = T0 + 5 * MIN;

    const waiting = monitor.getSnapshot();
    expect(waiting.open.chain_delay.max).toBe(5 * MIN);
    expect(waiting.open.total.max).toBe(5 * MIN);
    expect(waiting.open.provider_wait.count).toBe(0);

    monitor.recordStage(1, "chain_confirmed", T0 + 6 * MIN);
    const done = monitor.getSnapshot();
    expect(done.completed.chain_delay.count).toBe(1);
    expect(done.completed.total.p50).toBe(6 * MIN);
    expect(done.completed.provider_wait.count).toBe(0);
  });

  it("stops tracking an abandoned match and counts it once", () => {
    const { monitor } = setup();
    monitor.recordStage(1, "activated", T0);

    monitor.abandon(1, "TIMED_OUT");
    monitor.abandon(1, "TIMED_OUT");
    monitor.recordStage(1, "activated", T0);

    const snapshot = monitor.getSnapshot();
    expect(snapshot.openMatches).toBe(0);
    expect(snapshot.abandoned).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      { match_id: 1, reason: "TIMED_OUT" },
      "settlement_age_match_abandoned",
    );
  });

  it("evicts the oldest open match when the tracking limit is reached", () => {
    const { monitor } = setup({ maxTracked: 2 });
    monitor.recordStage(1, "activated", T0);
    monitor.recordStage(2, "activated", T0);
    monitor.recordStage(3, "activated", T0);

    const snapshot = monitor.getSnapshot();
    expect(snapshot.openMatches).toBe(2);
    expect(snapshot.evicted).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ evicted: 1, max_tracked: 2 }),
      "settlement_age_tracking_limit_reached",
    );
  });

  it("records activation from jobs, using their creation time, and is idempotent", () => {
    const { monitor, clock } = setup();
    const jobs = [
      { matchId: 1, createdAt: T0 },
      { matchId: 2, createdAt: T0 + MIN },
    ];

    monitor.syncActivations(jobs);
    monitor.syncActivations(jobs);
    clock.now = T0 + 10 * MIN;

    const snapshot = monitor.getSnapshot();
    expect(snapshot.openMatches).toBe(2);
    expect(snapshot.open.provider_wait.max).toBe(10 * MIN);
  });
});

describe("publishing", () => {
  it("publishNow logs one metric line with the snapshot", () => {
    const { monitor } = setup();
    monitor.recordStage(1, "activated", T0);

    monitor.publishNow();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: "settlement_age", openMatches: 1 }),
      "settlement_age_metrics",
    );
  });

  it("startPublisher syncs jobs, publishes now and on every tick, and can be stopped", () => {
    const { monitor } = setup();
    const setIntervalFn = vi.fn((_fn: () => void, _ms: number) => "handle");
    const clearIntervalFn = vi.fn();
    const listActiveJobs = vi.fn(() => [{ matchId: 1, createdAt: T0 }]);

    const stop = monitor.startPublisher({
      intervalMs: 5_000,
      setIntervalFn,
      clearIntervalFn,
      listActiveJobs,
    });

    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 5_000);
    expect(listActiveJobs).toHaveBeenCalledTimes(1);
    expect(monitor.getSnapshot().openMatches).toBe(1);

    const tick = setIntervalFn.mock.calls[0][0];
    tick();
    expect(listActiveJobs).toHaveBeenCalledTimes(2);

    stop();
    expect(clearIntervalFn).toHaveBeenCalledWith("handle");
  });

  it("startPublisher survives a failing job listing", () => {
    const { monitor } = setup();
    const listActiveJobs = vi.fn(() => {
      throw new Error("store closed");
    });

    expect(() =>
      monitor.startPublisher({
        setIntervalFn: () => "handle",
        clearIntervalFn: vi.fn(),
        listActiveJobs,
      }),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      { error: "store closed" },
      "settlement_age_publish_failed",
    );
  });
});

describe("configuration", () => {
  it("loads defaults when nothing is set", () => {
    expect(loadSettlementAgeConfig({})).toEqual(DEFAULT_SETTLEMENT_AGE_CONFIG);
    expect(getSettlementPublishIntervalMs({})).toBe(60_000);
  });

  it("reads overrides from the environment", () => {
    const config = loadSettlementAgeConfig({
      SETTLEMENT_AGE_PROVIDER_WAIT_MS: "1000",
      SETTLEMENT_AGE_SUBMISSION_LAG_MS: "2000",
      SETTLEMENT_AGE_CHAIN_DELAY_MS: "3000",
      SETTLEMENT_AGE_TOTAL_MS: "4000",
      SETTLEMENT_AGE_COMPLETED_WINDOW: "50",
      SETTLEMENT_AGE_MIN_SAMPLES: "3",
      SETTLEMENT_AGE_MAX_TRACKED: "99",
    });

    expect(config).toEqual({
      providerWaitMs: 1000,
      submissionLagMs: 2000,
      chainDelayMs: 3000,
      totalMs: 4000,
      completedWindow: 50,
      minSamples: 3,
      maxTracked: 99,
    });
    expect(
      getSettlementPublishIntervalMs({
        SETTLEMENT_AGE_PUBLISH_INTERVAL_MS: "5000",
      }),
    ).toBe(5000);
  });

  it("throws on invalid values", () => {
    expect(() =>
      loadSettlementAgeConfig({ SETTLEMENT_AGE_PROVIDER_WAIT_MS: "abc" }),
    ).toThrow(/SETTLEMENT_AGE_PROVIDER_WAIT_MS/);
    expect(() =>
      loadSettlementAgeConfig({ SETTLEMENT_AGE_PROVIDER_WAIT_MS: "0" }),
    ).toThrow(/providerWaitMs/);
    expect(() =>
      loadSettlementAgeConfig({ SETTLEMENT_AGE_COMPLETED_WINDOW: "0" }),
    ).toThrow(/completedWindow/);
    expect(() =>
      loadSettlementAgeConfig({ SETTLEMENT_AGE_MIN_SAMPLES: "500" }),
    ).toThrow(/minSamples cannot exceed completedWindow/);
    expect(() =>
      getSettlementPublishIntervalMs({
        SETTLEMENT_AGE_PUBLISH_INTERVAL_MS: "0",
      }),
    ).toThrow(/SETTLEMENT_AGE_PUBLISH_INTERVAL_MS/);
  });

  it("rejects an invalid config passed to the constructor", () => {
    expect(() => new SettlementAgeMonitor({ maxTracked: 0 })).toThrow(
      /maxTracked/,
    );
  });
});

describe("createSettlementAgeMonitorFromEnv", () => {
  it("returns null and clears the active monitor when disabled", () => {
    setSettlementAgeMonitor(new SettlementAgeMonitor());
    expect(
      createSettlementAgeMonitorFromEnv({
        SETTLEMENT_AGE_MONITOR_ENABLED: "false",
      }),
    ).toBeNull();
    expect(getSettlementAgeMonitor()).toBeNull();
  });

  it("creates the monitor and registers it as the active one", () => {
    const monitor = createSettlementAgeMonitorFromEnv({});
    expect(monitor).toBeInstanceOf(SettlementAgeMonitor);
    expect(getSettlementAgeMonitor()).toBe(monitor);
  });

  it("fails loudly on invalid configuration", () => {
    expect(() =>
      createSettlementAgeMonitorFromEnv({ SETTLEMENT_AGE_TOTAL_MS: "abc" }),
    ).toThrow(/SETTLEMENT_AGE_TOTAL_MS/);
  });
});

describe("trackSubmission and trackExistence", () => {
  it("records submission start before the handler and confirmation after it", async () => {
    const { monitor } = setup();
    let openWhileRunning = -1;
    const handler = vi.fn(async () => {
      openWhileRunning = monitor.getSnapshot().open.chain_delay.count;
    });

    await trackSubmission(monitor, handler)({ matchId: 7 });

    expect(openWhileRunning).toBe(1);
    const snapshot = monitor.getSnapshot();
    expect(snapshot.openMatches).toBe(0);
    expect(snapshot.completed.chain_delay.count).toBe(1);
  });

  it("rethrows a failure and leaves the match waiting on the chain", async () => {
    const { monitor } = setup();
    const handler = vi.fn(async () => {
      throw new Error("rpc timeout");
    });

    await expect(
      trackSubmission(monitor, handler)({ matchId: 7 }),
    ).rejects.toThrow("rpc timeout");

    expect(monitor.getSnapshot().open.chain_delay.count).toBe(1);
  });

  it("returns the original handler and checker when there is no monitor", () => {
    const handler = vi.fn(async () => undefined);
    const checker = vi.fn(async () => false);

    expect(trackSubmission(null, handler)).toBe(handler);
    expect(trackExistence(null, checker)).toBe(checker);
  });

  it("closes the match when the result already exists on-chain", async () => {
    const { monitor } = setup();
    monitor.recordStage(7, "activated", T0);

    const exists = await trackExistence(monitor, async () => true)(7);

    expect(exists).toBe(true);
    expect(monitor.getSnapshot().openMatches).toBe(0);
  });

  it("leaves the match open when the result does not exist yet", async () => {
    const { monitor } = setup();
    monitor.recordStage(7, "activated", T0);

    const exists = await trackExistence(monitor, async () => false)(7);

    expect(exists).toBe(false);
    expect(monitor.getSnapshot().openMatches).toBe(1);
  });
});

describe("safety: observability only", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/services/settlement-age-monitor.ts"),
    "utf8",
  );

  it("never signs, broadcasts or names settlement functions", () => {
    expect(source).not.toMatch(
      /sendTransaction|submit_result|override_result|\.sign\(/,
    );
  });

  it("imports nothing but the logger", () => {
    const importLines = source
      .split("\n")
      .filter(
        (line) => /^\s*import\s/.test(line) || /\bfrom\s+['"]/.test(line),
      );

    expect(importLines.map((line) => line.replace(/"/g, "'").trim())).toEqual([
      "import logger from '../logger.js';",
    ]);
  });
});
