import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/logger.js", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import logger from "../../src/logger.js";
import {
  DEFAULT_DISAGREEMENT_MONITOR_CONFIG,
  OutcomeDisagreementMonitor,
  loadDisagreementMonitorConfig,
  toPlayer1Perspective,
} from "../../src/services/outcome-disagreement-monitor.js";
import type {
  DisagreementMonitorConfig,
  MatchEvidenceInput,
  MonitorOptions,
  Observation,
  ObservationKind,
  OutcomeEvidenceSources,
} from "../../src/services/outcome-disagreement-monitor.js";
import type { GameResult, MatchResult } from "../../src/fetchers/lichess.js";

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

const CFG: DisagreementMonitorConfig = {
  windowSize: 10,
  maxAgeMs: HOUR,
  minDecided: 5,
  minDisagreements: 3,
  minDisagreementRate: 0.2,
};

function game(
  white: string,
  black: string,
  result: MatchResult | null,
): GameResult {
  return {
    gameId: "g1",
    result,
    whitePlayer: white,
    blackPlayer: black,
    status: result === null ? "started" : "mate",
  } as unknown as GameResult;
}

function evidence(matchId = 1): MatchEvidenceInput {
  return {
    matchId,
    gameId: `game-${matchId}`,
    platform: "lichess",
    player1Username: "Alice",
    player2Username: "Bob",
  };
}

function createMonitor(
  config: Partial<DisagreementMonitorConfig> = {},
  options: MonitorOptions = {},
) {
  const clock = { now: T0 };
  const fetchProviderResult = vi.fn();
  const readChainResult = vi.fn();
  const sources: OutcomeEvidenceSources = {
    fetchProviderResult,
    readChainResult,
  };
  const monitor = new OutcomeDisagreementMonitor(
    sources,
    { ...CFG, ...config },
    { now: () => clock.now, ...options },
  );
  return { monitor, clock, sources, fetchProviderResult, readChainResult };
}

function obs(
  matchId: number,
  kind: ObservationKind,
  observedAt: number,
  platform = "lichess",
): Observation {
  return { matchId, platform, kind, observedAt };
}

function feed(
  monitor: OutcomeDisagreementMonitor,
  clock: { now: number },
  kinds: ObservationKind[],
  startId = 1,
  platform = "lichess",
) {
  kinds.forEach((kind, i) => {
    monitor.record(obs(startId + i, kind, clock.now, platform));
  });
}

function repeat(kind: ObservationKind, n: number): ObservationKind[] {
  return Array.from({ length: n }, () => kind);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toPlayer1Perspective", () => {
  it("keeps the result when Player 1 played white", () => {
    expect(
      toPlayer1Perspective(game("Alice", "Bob", "Player1Wins"), evidence()),
    ).toBe("Player1Wins");
    expect(
      toPlayer1Perspective(game("Alice", "Bob", "Player2Wins"), evidence()),
    ).toBe("Player2Wins");
  });

  it("flips the result when Player 1 played black", () => {
    expect(
      toPlayer1Perspective(game("Bob", "Alice", "Player1Wins"), evidence()),
    ).toBe("Player2Wins");
    expect(
      toPlayer1Perspective(game("Bob", "Alice", "Player2Wins"), evidence()),
    ).toBe("Player1Wins");
  });

  it("keeps a draw as a draw in either color arrangement", () => {
    expect(toPlayer1Perspective(game("Alice", "Bob", "Draw"), evidence())).toBe(
      "Draw",
    );
    expect(toPlayer1Perspective(game("Bob", "Alice", "Draw"), evidence())).toBe(
      "Draw",
    );
  });

  it("ignores case and surrounding whitespace in usernames", () => {
    expect(
      toPlayer1Perspective(game(" ALICE ", "bob", "Player1Wins"), evidence()),
    ).toBe("Player1Wins");
  });

  it("returns null while the game is in progress", () => {
    expect(
      toPlayer1Perspective(game("Alice", "Bob", null), evidence()),
    ).toBeNull();
  });

  it("returns null when players cannot be mapped to the match", () => {
    expect(
      toPlayer1Perspective(game("Carol", "Bob", "Player1Wins"), evidence()),
    ).toBeNull();
    expect(
      toPlayer1Perspective(game("Alice", "Alice", "Player1Wins"), evidence()),
    ).toBeNull();
    expect(
      toPlayer1Perspective(game("", "", "Player1Wins"), evidence()),
    ).toBeNull();
  });
});

describe("OutcomeDisagreementMonitor.checkMatch classification", () => {
  it("records agreement when chain and provider match", async () => {
    const { monitor, fetchProviderResult, readChainResult } = createMonitor();
    readChainResult.mockResolvedValue("Player1Wins");
    fetchProviderResult.mockResolvedValue(game("Alice", "Bob", "Player1Wins"));

    const result = await monitor.checkMatch(evidence());

    expect(result.kind).toBe("agree");
    expect(result.providerOutcome).toBe("Player1Wins");
    expect(result.chainOutcome).toBe("Player1Wins");
    expect(monitor.getStatus().windowObservations).toBe(1);
  });

  it("records disagreement when the chain outcome differs from the provider", async () => {
    const { monitor, fetchProviderResult, readChainResult } = createMonitor();
    readChainResult.mockResolvedValue("Player2Wins");
    fetchProviderResult.mockResolvedValue(game("Alice", "Bob", "Player1Wins"));

    const result = await monitor.checkMatch(evidence());

    expect(result.kind).toBe("disagree");
    expect(result.providerOutcome).toBe("Player1Wins");
    expect(result.chainOutcome).toBe("Player2Wins");
  });

  it("does not flag a correct result when Player 1 played black", async () => {
    const { monitor, fetchProviderResult, readChainResult } = createMonitor();
    // White (Bob) won, so from Player 1's perspective Player 2 won.
    fetchProviderResult.mockResolvedValue(game("Bob", "Alice", "Player1Wins"));
    readChainResult.mockResolvedValue("Player2Wins");

    const result = await monitor.checkMatch(evidence());

    expect(result.kind).toBe("agree");
  });

  it("flags a wrong result when Player 1 played black", async () => {
    const { monitor, fetchProviderResult, readChainResult } = createMonitor();
    fetchProviderResult.mockResolvedValue(game("Bob", "Alice", "Player1Wins"));
    readChainResult.mockResolvedValue("Player1Wins");

    const result = await monitor.checkMatch(evidence());

    expect(result.kind).toBe("disagree");
  });

  it("is unverifiable (provider_error) when the provider fails", async () => {
    const { monitor, fetchProviderResult, readChainResult } = createMonitor();
    readChainResult.mockResolvedValue("Player1Wins");
    fetchProviderResult.mockRejectedValue(new Error("provider down"));

    const result = await monitor.checkMatch(evidence());

    expect(result.kind).toBe("unverifiable");
    expect(result.reason).toBe("provider_error");
    expect(monitor.getStatus().disagreements).toBe(0);
  });

  it("is unverifiable (chain_error) when the chain read fails, without calling the provider", async () => {
    const { monitor, fetchProviderResult, readChainResult } = createMonitor();
    readChainResult.mockRejectedValue(new Error("rpc timeout"));

    const result = await monitor.checkMatch(evidence());

    expect(result.kind).toBe("unverifiable");
    expect(result.reason).toBe("chain_error");
    expect(fetchProviderResult).not.toHaveBeenCalled();
  });

  it("is unverifiable (no_chain_result) when nothing is recorded on-chain", async () => {
    const { monitor, fetchProviderResult, readChainResult } = createMonitor();
    readChainResult.mockResolvedValue(null);

    const result = await monitor.checkMatch(evidence());

    expect(result.kind).toBe("unverifiable");
    expect(result.reason).toBe("no_chain_result");
    expect(fetchProviderResult).not.toHaveBeenCalled();
  });

  it("is unverifiable (game_in_progress) when the provider has no result yet", async () => {
    const { monitor, fetchProviderResult, readChainResult } = createMonitor();
    readChainResult.mockResolvedValue("Player1Wins");
    fetchProviderResult.mockResolvedValue(game("Alice", "Bob", null));

    const result = await monitor.checkMatch(evidence());

    expect(result.kind).toBe("unverifiable");
    expect(result.reason).toBe("game_in_progress");
  });

  it("is unverifiable (identity_unmappable) when players do not match the match record", async () => {
    const { monitor, fetchProviderResult, readChainResult } = createMonitor();
    readChainResult.mockResolvedValue("Player1Wins");
    fetchProviderResult.mockResolvedValue(game("Carol", "Dave", "Player1Wins"));

    const result = await monitor.checkMatch(evidence());

    expect(result.kind).toBe("unverifiable");
    expect(result.reason).toBe("identity_unmappable");
  });
});

describe("thresholds", () => {
  it("does not raise a signal below the minimum decided observations", () => {
    const { monitor, clock } = createMonitor();
    feed(monitor, clock, repeat("disagree", 4));

    const status = monitor.getStatus();
    expect(status.decided).toBe(4);
    expect(status.reviewRequired).toBe(false);

    feed(monitor, clock, ["disagree"], 5);
    expect(monitor.getStatus().reviewRequired).toBe(true);
  });

  it("does not raise a signal below the minimum number of disagreements", () => {
    const { monitor, clock } = createMonitor();
    feed(monitor, clock, [...repeat("disagree", 2), ...repeat("agree", 3)]);

    const status = monitor.getStatus();
    expect(status.decided).toBe(5);
    expect(status.disagreements).toBe(2);
    expect(status.reviewRequired).toBe(false);
  });

  it("does not raise a signal when the disagreement rate is too low", () => {
    const { monitor, clock } = createMonitor({ windowSize: 30 });
    feed(monitor, clock, [...repeat("disagree", 3), ...repeat("agree", 17)]);

    const low = monitor.getStatus();
    expect(low.disagreements).toBe(3);
    expect(low.disagreementRate).toBeCloseTo(0.15, 5);
    expect(low.reviewRequired).toBe(false);

    feed(monitor, clock, repeat("disagree", 2), 100);
    const high = monitor.getStatus();
    expect(high.disagreements).toBe(5);
    expect(high.reviewRequired).toBe(true);
  });

  it("never counts unverifiable observations as disagreement", () => {
    const { monitor, clock } = createMonitor({ windowSize: 20 });
    feed(monitor, clock, [
      ...repeat("unverifiable", 10),
      ...repeat("disagree", 2),
    ]);

    const status = monitor.getStatus();
    expect(status.decided).toBe(2);
    expect(status.unverifiable).toBe(10);
    expect(status.reviewRequired).toBe(false);
  });

  it("reports degraded evidence when most of the window is unverifiable", () => {
    const { monitor, clock } = createMonitor();
    feed(monitor, clock, repeat("unverifiable", 6));

    const status = monitor.getStatus();
    expect(status.evidenceDegraded).toBe(true);
    expect(status.reviewRequired).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: "manual_review_only" }),
      "outcome_evidence_degraded",
    );
  });

  it("does not report degraded evidence when the window is mostly verifiable", () => {
    const { monitor, clock } = createMonitor();
    feed(monitor, clock, [...repeat("agree", 5), ...repeat("unverifiable", 2)]);

    expect(monitor.getStatus().evidenceDegraded).toBe(false);
  });
});

describe("window behaviour", () => {
  it("keeps only the most recent windowSize observations", () => {
    const { monitor, clock } = createMonitor();
    feed(monitor, clock, [...repeat("disagree", 5), ...repeat("agree", 10)]);

    const status = monitor.getStatus();
    expect(status.windowObservations).toBe(10);
    expect(status.disagreements).toBe(0);
    expect(status.disagreeingMatchIds).toEqual([]);
  });

  it("drops observations older than maxAgeMs", () => {
    const { monitor, clock } = createMonitor();
    feed(monitor, clock, repeat("disagree", 5));
    expect(monitor.getStatus().windowObservations).toBe(5);

    clock.now += HOUR + 1;

    const status = monitor.getStatus();
    expect(status.windowObservations).toBe(0);
    expect(status.reviewRequired).toBe(false);
  });

  it("replaces the earlier observation when the same match is re-observed", () => {
    const { monitor, clock } = createMonitor();
    monitor.record(obs(1, "disagree", clock.now));
    monitor.record(obs(1, "agree", clock.now));

    const status = monitor.getStatus();
    expect(status.windowObservations).toBe(1);
    expect(status.disagreements).toBe(0);
    expect(status.agreements).toBe(1);
  });

  it("breaks counts down by platform and lists disagreeing match ids", () => {
    const { monitor, clock } = createMonitor();
    monitor.record(obs(1, "disagree", clock.now, "lichess"));
    monitor.record(obs(2, "agree", clock.now, "lichess"));
    monitor.record(obs(3, "disagree", clock.now, "chessdotcom"));
    monitor.record(obs(4, "unverifiable", clock.now, "chessdotcom"));

    const status = monitor.getStatus();
    expect(status.byPlatform.lichess).toEqual({
      agree: 1,
      disagree: 1,
      unverifiable: 0,
    });
    expect(status.byPlatform.chessdotcom).toEqual({
      agree: 0,
      disagree: 1,
      unverifiable: 1,
    });
    expect(status.disagreeingMatchIds).toEqual([1, 3]);
  });

  it("getStatus is a read-only snapshot with no side effects", () => {
    const onReviewSignal = vi.fn();
    const { monitor, clock } = createMonitor({}, { onReviewSignal });
    feed(monitor, clock, repeat("disagree", 5));
    onReviewSignal.mockClear();
    vi.clearAllMocks();

    monitor.getStatus();
    monitor.getStatus();

    expect(onReviewSignal).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("review signal transitions", () => {
  it("logs and notifies exactly once when the signal is raised", () => {
    const onReviewSignal = vi.fn();
    const { monitor, clock } = createMonitor({}, { onReviewSignal });

    feed(monitor, clock, repeat("disagree", 7));

    expect(onReviewSignal).toHaveBeenCalledTimes(1);
    expect(onReviewSignal).toHaveBeenCalledWith(
      expect.objectContaining({ reviewRequired: true, disagreements: 5 }),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "manual_review_only",
        reviewRequired: true,
      }),
      "outcome_disagreement_review_required",
    );
  });

  it("logs recovery and can raise the signal again afterwards", () => {
    const onReviewSignal = vi.fn();
    const { monitor, clock } = createMonitor({}, { onReviewSignal });

    feed(monitor, clock, repeat("disagree", 5), 1);
    expect(onReviewSignal).toHaveBeenCalledTimes(1);

    feed(monitor, clock, repeat("agree", 10), 6);
    expect(monitor.getStatus().reviewRequired).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reviewRequired: false }),
      "outcome_disagreement_recovered",
    );

    feed(monitor, clock, repeat("disagree", 5), 16);
    expect(monitor.getStatus().reviewRequired).toBe(true);
    expect(onReviewSignal).toHaveBeenCalledTimes(2);
  });

  it("keeps working when the notifier throws", () => {
    const onReviewSignal = vi.fn(() => {
      throw new Error("pager down");
    });
    const { monitor, clock } = createMonitor({}, { onReviewSignal });

    expect(() => feed(monitor, clock, repeat("disagree", 5))).not.toThrow();
    expect(onReviewSignal).toHaveBeenCalledTimes(1);
    expect(monitor.getStatus().reviewRequired).toBe(true);
  });

  it("raising the signal never touches the evidence sources", () => {
    const { monitor, clock, fetchProviderResult, readChainResult } =
      createMonitor();

    feed(monitor, clock, repeat("disagree", 5));

    expect(monitor.getStatus().reviewRequired).toBe(true);
    expect(fetchProviderResult).not.toHaveBeenCalled();
    expect(readChainResult).not.toHaveBeenCalled();
  });
});

describe("safety: review only", () => {
  it("imports no submission, settlement, queue or Stellar code", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/services/outcome-disagreement-monitor.ts"),
      "utf8",
    );
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line) || /\bfrom\s+'/.test(line))
      .join("\n");

    expect(importLines).not.toMatch(
      /stellar|oracle-submit|oracle-service|queue|polling|match-store|escrow/i,
    );
  });
});

describe("configuration", () => {
  it("loads defaults when no environment variables are set", () => {
    expect(loadDisagreementMonitorConfig({})).toEqual(
      DEFAULT_DISAGREEMENT_MONITOR_CONFIG,
    );
  });

  it("ignores blank environment values", () => {
    expect(
      loadDisagreementMonitorConfig({ OUTCOME_DISAGREEMENT_WINDOW_SIZE: "  " }),
    ).toEqual(DEFAULT_DISAGREEMENT_MONITOR_CONFIG);
  });

  it("reads overrides from the environment", () => {
    const config = loadDisagreementMonitorConfig({
      OUTCOME_DISAGREEMENT_WINDOW_SIZE: "50",
      OUTCOME_DISAGREEMENT_MAX_AGE_HOURS: "2",
      OUTCOME_DISAGREEMENT_MIN_DECIDED: "10",
      OUTCOME_DISAGREEMENT_MIN_DISAGREEMENTS: "4",
      OUTCOME_DISAGREEMENT_MIN_RATE: "0.5",
    });

    expect(config).toEqual({
      windowSize: 50,
      maxAgeMs: 2 * HOUR,
      minDecided: 10,
      minDisagreements: 4,
      minDisagreementRate: 0.5,
    });
  });

  it("throws on values that are not numbers", () => {
    expect(() =>
      loadDisagreementMonitorConfig({
        OUTCOME_DISAGREEMENT_WINDOW_SIZE: "abc",
      }),
    ).toThrow(/not a valid number/);
  });

  it("throws on out-of-range values", () => {
    expect(() =>
      loadDisagreementMonitorConfig({ OUTCOME_DISAGREEMENT_MIN_RATE: "0" }),
    ).toThrow(/minDisagreementRate/);
    expect(() =>
      loadDisagreementMonitorConfig({ OUTCOME_DISAGREEMENT_MIN_RATE: "1.5" }),
    ).toThrow(/minDisagreementRate/);
    expect(() =>
      loadDisagreementMonitorConfig({ OUTCOME_DISAGREEMENT_WINDOW_SIZE: "0" }),
    ).toThrow(/windowSize/);
    expect(() =>
      loadDisagreementMonitorConfig({
        OUTCOME_DISAGREEMENT_WINDOW_SIZE: "5",
        OUTCOME_DISAGREEMENT_MIN_DECIDED: "10",
      }),
    ).toThrow(/minDecided cannot exceed windowSize/);
  });

  it("rejects an invalid config passed to the constructor", () => {
    const sources: OutcomeEvidenceSources = {
      fetchProviderResult: vi.fn(),
      readChainResult: vi.fn(),
    };
    expect(
      () => new OutcomeDisagreementMonitor(sources, { minDisagreementRate: 0 }),
    ).toThrow(/minDisagreementRate/);
  });
});
