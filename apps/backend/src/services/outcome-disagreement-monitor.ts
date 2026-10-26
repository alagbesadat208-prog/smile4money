/**
 * Outcome Disagreement Monitor
 *
 * Review signal for the case where a compromised reporter or an anomalous
 * game provider only becomes visible after outcomes repeatedly disagree with
 * independent evidence.
 *
 * For each settled match the monitor compares two sources it does not control:
 *   1. the outcome recorded on-chain (what the reporter actually submitted), and
 *   2. a fresh outcome fetched from the chess platform by the monitor itself.
 *
 * The provider outcome is normalised to Player 1's perspective first, because
 * Player 1 is not always the white player (see verifyPlayerIdentities, which
 * accepts swapped colors). Without that step a correct result would look like
 * a disagreement.
 *
 * Each observation is classified as:
 *   - agree
 *   - disagree
 *   - unverifiable: game still in progress, no chain result yet, a provider or
 *     RPC failure, or players that cannot be mapped to colors. Unverifiable
 *     observations are NEVER counted as disagreement, but when most of the
 *     window is unverifiable the monitor reports degraded evidence so an
 *     outage cannot hide an attack.
 *
 * A review signal is raised when, within the sliding window (last N
 * observations, no older than a maximum age), there are at least
 * `minDecided` decided observations, at least `minDisagreements` of them
 * disagree, and the disagreement rate is at least `minDisagreementRate`.
 *
 * SAFETY: this module is review-only. Its sole dependencies are two READ
 * functions. It imports no submission, settlement, queue or Stellar code, and
 * raising the signal only emits a structured log line and calls an optional
 * notification callback. It never reverses, overrides or settles anything.
 */

import type { GameResult, MatchResult } from "../fetchers/lichess.js";
import logger from "../logger.js";

export type ObservationKind = "agree" | "disagree" | "unverifiable";

export type UnverifiableReason =
  | "provider_error"
  | "game_in_progress"
  | "identity_unmappable"
  | "chain_error"
  | "no_chain_result";

/** What the monitor needs to know about a settled match. */
export interface MatchEvidenceInput {
  matchId: number;
  gameId: string;
  platform: string;
  player1Username: string;
  player2Username: string;
}

/**
 * The only capabilities the monitor has. Both are read-only by design: there
 * is deliberately no way to submit, override or settle through this interface.
 */
export interface OutcomeEvidenceSources {
  /** Fetch the game result from the chess platform, independently of the reporter. */
  fetchProviderResult: (input: MatchEvidenceInput) => Promise<GameResult>;
  /** Read the outcome recorded on-chain for a match, or null if none is recorded. */
  readChainResult: (matchId: number) => Promise<MatchResult | null>;
}

export interface Observation {
  matchId: number;
  platform: string;
  kind: ObservationKind;
  reason?: UnverifiableReason;
  providerOutcome?: MatchResult;
  chainOutcome?: MatchResult;
  observedAt: number;
}

export interface DisagreementMonitorConfig {
  /** Maximum number of most recent observations kept in the window. */
  windowSize: number;
  /** Observations older than this (ms) fall out of the window. */
  maxAgeMs: number;
  /** Minimum decided (agree + disagree) observations before a signal can be raised. */
  minDecided: number;
  /** Minimum number of disagreements before a signal can be raised. */
  minDisagreements: number;
  /** Minimum disagreement rate (disagreements / decided), between 0 and 1. */
  minDisagreementRate: number;
}

export interface PlatformCounts {
  agree: number;
  disagree: number;
  unverifiable: number;
}

export interface MonitorStatus {
  /** True when the sustained-disagreement thresholds are met. Review only. */
  reviewRequired: boolean;
  /** True when most of the window could not be verified (outage or blind spot). */
  evidenceDegraded: boolean;
  windowObservations: number;
  decided: number;
  agreements: number;
  disagreements: number;
  unverifiable: number;
  disagreementRate: number;
  byPlatform: Record<string, PlatformCounts>;
  /** Most recent disagreeing match ids, to start a manual review from. */
  disagreeingMatchIds: number[];
  thresholds: DisagreementMonitorConfig;
}

export interface MonitorOptions {
  /** Clock, injectable for tests. */
  now?: () => number;
  /**
   * Notified when the review signal is raised. Must only notify humans or
   * monitoring; it receives a status snapshot and cannot act on funds.
   */
  onReviewSignal?: (status: MonitorStatus) => void;
}

export const DEFAULT_DISAGREEMENT_MONITOR_CONFIG: DisagreementMonitorConfig = {
  windowSize: 20,
  maxAgeMs: 24 * 60 * 60 * 1000,
  minDecided: 5,
  minDisagreements: 3,
  minDisagreementRate: 0.2,
};

/** Fraction of the window that must be unverifiable to report degraded evidence. */
const DEGRADED_EVIDENCE_RATE = 0.5;
const MAX_REPORTED_MATCH_IDS = 20;

function normalizeName(name: string): string {
  return (name || "").trim().toLowerCase();
}

function flip(result: MatchResult): MatchResult {
  if (result === "Player1Wins") return "Player2Wins";
  if (result === "Player2Wins") return "Player1Wins";
  return "Draw";
}

/**
 * Express a provider result from Player 1's perspective.
 *
 * The fetchers report results as white vs black (white = "Player1Wins"). If
 * Player 1 played black the result must be flipped. Returns null when the
 * game is still in progress or the players cannot be mapped to the match.
 */
export function toPlayer1Perspective(
  game: GameResult,
  input: Pick<MatchEvidenceInput, "player1Username" | "player2Username">,
): MatchResult | null {
  if (game.result === null) return null;

  const white = normalizeName(game.whitePlayer);
  const black = normalizeName(game.blackPlayer);
  const player1 = normalizeName(input.player1Username);
  const player2 = normalizeName(input.player2Username);

  if (!white || !black || !player1 || !player2) return null;

  if (white === player1 && black === player2) return game.result;
  if (white === player2 && black === player1) return flip(game.result);
  return null;
}

function validateConfig(config: DisagreementMonitorConfig): void {
  const positiveInt = (name: string, value: number) => {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `Invalid ${name}: must be a positive integer, got ${value}`,
      );
    }
  };
  positiveInt("windowSize", config.windowSize);
  positiveInt("minDecided", config.minDecided);
  positiveInt("minDisagreements", config.minDisagreements);

  if (!Number.isFinite(config.maxAgeMs) || config.maxAgeMs <= 0) {
    throw new Error(
      `Invalid maxAgeMs: must be a positive number, got ${config.maxAgeMs}`,
    );
  }
  if (
    !Number.isFinite(config.minDisagreementRate) ||
    config.minDisagreementRate <= 0 ||
    config.minDisagreementRate > 1
  ) {
    throw new Error(
      `Invalid minDisagreementRate: must be greater than 0 and at most 1, got ${config.minDisagreementRate}`,
    );
  }
  if (config.minDecided > config.windowSize) {
    throw new Error("Invalid config: minDecided cannot exceed windowSize");
  }
  if (config.minDisagreements > config.windowSize) {
    throw new Error(
      "Invalid config: minDisagreements cannot exceed windowSize",
    );
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
 *   OUTCOME_DISAGREEMENT_WINDOW_SIZE       default 20
 *   OUTCOME_DISAGREEMENT_MAX_AGE_HOURS     default 24
 *   OUTCOME_DISAGREEMENT_MIN_DECIDED       default 5
 *   OUTCOME_DISAGREEMENT_MIN_DISAGREEMENTS default 3
 *   OUTCOME_DISAGREEMENT_MIN_RATE          default 0.2
 */
export function loadDisagreementMonitorConfig(
  env: Record<string, string | undefined> = process.env,
): DisagreementMonitorConfig {
  const defaults = DEFAULT_DISAGREEMENT_MONITOR_CONFIG;
  const config: DisagreementMonitorConfig = {
    windowSize: readNumber(
      env,
      "OUTCOME_DISAGREEMENT_WINDOW_SIZE",
      defaults.windowSize,
    ),
    maxAgeMs:
      readNumber(
        env,
        "OUTCOME_DISAGREEMENT_MAX_AGE_HOURS",
        defaults.maxAgeMs / (60 * 60 * 1000),
      ) *
      60 *
      60 *
      1000,
    minDecided: readNumber(
      env,
      "OUTCOME_DISAGREEMENT_MIN_DECIDED",
      defaults.minDecided,
    ),
    minDisagreements: readNumber(
      env,
      "OUTCOME_DISAGREEMENT_MIN_DISAGREEMENTS",
      defaults.minDisagreements,
    ),
    minDisagreementRate: readNumber(
      env,
      "OUTCOME_DISAGREEMENT_MIN_RATE",
      defaults.minDisagreementRate,
    ),
  };
  validateConfig(config);
  return config;
}

export class OutcomeDisagreementMonitor {
  private readonly sources: OutcomeEvidenceSources;
  private readonly config: DisagreementMonitorConfig;
  private readonly now: () => number;
  private readonly onReviewSignal?: (status: MonitorStatus) => void;
  private observations: Observation[] = [];
  private reviewActive = false;
  private degradedActive = false;

  constructor(
    sources: OutcomeEvidenceSources,
    config: Partial<DisagreementMonitorConfig> = {},
    options: MonitorOptions = {},
  ) {
    this.sources = sources;
    this.config = { ...DEFAULT_DISAGREEMENT_MONITOR_CONFIG, ...config };
    validateConfig(this.config);
    this.now = options.now ?? Date.now;
    this.onReviewSignal = options.onReviewSignal;
  }

  /**
   * Gather the independent evidence for one settled match, classify it and
   * record it. Never throws: any failure becomes an `unverifiable`
   * observation.
   */
  async checkMatch(input: MatchEvidenceInput): Promise<Observation> {
    const base = {
      matchId: input.matchId,
      platform: input.platform,
      observedAt: this.now(),
    };

    let chainOutcome: MatchResult | null;
    try {
      chainOutcome = await this.sources.readChainResult(input.matchId);
    } catch {
      return this.finish({
        ...base,
        kind: "unverifiable",
        reason: "chain_error",
      });
    }
    if (chainOutcome === null) {
      return this.finish({
        ...base,
        kind: "unverifiable",
        reason: "no_chain_result",
      });
    }

    let game: GameResult;
    try {
      game = await this.sources.fetchProviderResult(input);
    } catch {
      return this.finish({
        ...base,
        kind: "unverifiable",
        reason: "provider_error",
      });
    }
    if (game.result === null) {
      return this.finish({
        ...base,
        kind: "unverifiable",
        reason: "game_in_progress",
      });
    }

    const providerOutcome = toPlayer1Perspective(game, input);
    if (providerOutcome === null) {
      return this.finish({
        ...base,
        kind: "unverifiable",
        reason: "identity_unmappable",
      });
    }

    return this.finish({
      ...base,
      kind: providerOutcome === chainOutcome ? "agree" : "disagree",
      providerOutcome,
      chainOutcome,
    });
  }

  /** Record an observation produced elsewhere. Re-observing a match replaces its earlier entry. */
  record(observation: Observation): MonitorStatus {
    this.prune();
    this.observations = this.observations.filter(
      (o) => o.matchId !== observation.matchId,
    );
    this.observations.push(observation);
    this.prune();

    const status = this.computeStatus();
    this.handleTransitions(status);
    return status;
  }

  /** Read-only snapshot of the current window. Has no side effects. */
  getStatus(): MonitorStatus {
    this.prune();
    return this.computeStatus();
  }

  private finish(observation: Observation): Observation {
    this.record(observation);
    return observation;
  }

  private prune(): void {
    const cutoff = this.now() - this.config.maxAgeMs;
    this.observations = this.observations.filter((o) => o.observedAt > cutoff);
    if (this.observations.length > this.config.windowSize) {
      this.observations = this.observations.slice(-this.config.windowSize);
    }
  }

  private computeStatus(): MonitorStatus {
    let agreements = 0;
    let disagreements = 0;
    let unverifiable = 0;
    const byPlatform: Record<string, PlatformCounts> = {};
    const disagreeingMatchIds: number[] = [];

    for (const o of this.observations) {
      const counts = (byPlatform[o.platform] ??= {
        agree: 0,
        disagree: 0,
        unverifiable: 0,
      });
      counts[o.kind] += 1;
      if (o.kind === "agree") agreements += 1;
      else if (o.kind === "disagree") {
        disagreements += 1;
        disagreeingMatchIds.push(o.matchId);
      } else unverifiable += 1;
    }

    const decided = agreements + disagreements;
    const disagreementRate = decided === 0 ? 0 : disagreements / decided;
    const total = this.observations.length;

    const reviewRequired =
      decided >= this.config.minDecided &&
      disagreements >= this.config.minDisagreements &&
      disagreementRate >= this.config.minDisagreementRate;

    const evidenceDegraded =
      total >= this.config.minDecided &&
      unverifiable / total >= DEGRADED_EVIDENCE_RATE;

    return {
      reviewRequired,
      evidenceDegraded,
      windowObservations: total,
      decided,
      agreements,
      disagreements,
      unverifiable,
      disagreementRate,
      byPlatform,
      disagreeingMatchIds: disagreeingMatchIds.slice(-MAX_REPORTED_MATCH_IDS),
      thresholds: { ...this.config },
    };
  }

  /** Log and notify once per transition, not once per observation. */
  private handleTransitions(status: MonitorStatus): void {
    if (status.reviewRequired && !this.reviewActive) {
      this.reviewActive = true;
      logger.error(
        { ...status, action: "manual_review_only" },
        "outcome_disagreement_review_required",
      );
      try {
        this.onReviewSignal?.(status);
      } catch {
        // A failing notifier must never affect the monitor.
      }
    } else if (!status.reviewRequired && this.reviewActive) {
      this.reviewActive = false;
      logger.info({ ...status }, "outcome_disagreement_recovered");
    }

    if (status.evidenceDegraded && !this.degradedActive) {
      this.degradedActive = true;
      logger.warn(
        { ...status, action: "manual_review_only" },
        "outcome_evidence_degraded",
      );
    } else if (!status.evidenceDegraded && this.degradedActive) {
      this.degradedActive = false;
      logger.info({ ...status }, "outcome_evidence_recovered");
    }
  }
}

export default OutcomeDisagreementMonitor;
