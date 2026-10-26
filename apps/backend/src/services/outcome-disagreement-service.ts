/**
 * Outcome Disagreement Service
 *
 * Connects the review-only OutcomeDisagreementMonitor to live evidence:
 *   - the on-chain outcome, read with read-only simulations of the oracle
 *     contract's `has_result` and `get_result` functions, and
 *   - a fresh outcome fetched from the chess platform by this process.
 *
 * SAFETY: this module only reads. It builds simulations, never signs or
 * broadcasts a transaction, and imports no queue, polling or oracle
 * submission code. Raising the review signal only logs and notifies.
 */

import { fetchLichessResult } from "../fetchers/lichess.js";
import { fetchChessDotComResult } from "../fetchers/chessdotcom.js";
import type { GameResult, MatchResult } from "../fetchers/lichess.js";
import logger from "../logger.js";
import {
  OutcomeDisagreementMonitor,
  loadDisagreementMonitorConfig,
} from "./outcome-disagreement-monitor.js";
import type {
  DisagreementMonitorConfig,
  MatchEvidenceInput,
  MonitorStatus,
  Observation,
  OutcomeEvidenceSources,
} from "./outcome-disagreement-monitor.js";

const DEFAULT_CHECK_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CHECK_ATTEMPTS = 3;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

/** The only contract functions this module is able to call. */
export type ReadOnlyContractFn = "has_result" | "get_result";

export type ContractInvoker = (
  fn: ReadOnlyContractFn,
  matchId: number,
) => Promise<unknown>;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Decode a MatchResult as returned by scValToNative (a string or a one-element array). */
export function decodeMatchResult(value: unknown): MatchResult {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (
    candidate === "Player1Wins" ||
    candidate === "Player2Wins" ||
    candidate === "Draw"
  ) {
    return candidate;
  }
  throw new Error(`Unexpected match result value: ${JSON.stringify(value)}`);
}

/** Decode a ResultEntry ({ game_id, result, submitted_ledger }) into its MatchResult. */
export function decodeResultEntry(native: unknown): MatchResult {
  if (native instanceof Map) {
    return decodeMatchResult(native.get("result"));
  }
  if (native !== null && typeof native === "object") {
    return decodeMatchResult((native as Record<string, unknown>).result);
  }
  throw new Error(`Unexpected result entry value: ${JSON.stringify(native)}`);
}

export interface ChainReaderOptions {
  timeoutMs?: number;
}

/**
 * Build the chain reader: returns null when no result is recorded, otherwise
 * the recorded outcome. Uses `has_result` first so a missing result never has
 * to be detected from a contract error.
 */
export function createChainResultReader(
  invoke: ContractInvoker,
  options: ChainReaderOptions = {},
): (matchId: number) => Promise<MatchResult | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const call = (fn: ReadOnlyContractFn, matchId: number) =>
    withTimeout(
      Promise.resolve(invoke(fn, matchId)),
      timeoutMs,
      `chain read ${fn}`,
    );

  return async (matchId: number) => {
    const exists = await call("has_result", matchId);
    if (typeof exists !== "boolean") {
      throw new Error(`Unexpected has_result value: ${JSON.stringify(exists)}`);
    }
    if (!exists) return null;
    return decodeResultEntry(await call("get_result", matchId));
  };
}

export interface SdkInvokerConfig {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
}

/** Read-only invoker: simulates the call against the RPC and decodes the return value. */
export function createSdkContractInvoker(
  config: SdkInvokerConfig,
): ContractInvoker {
  return async (fn, matchId) => {
    const sdk = await import("@stellar/stellar-sdk");
    const {
      Account,
      BASE_FEE,
      Contract,
      Keypair,
      TransactionBuilder,
      nativeToScVal,
      rpc,
    } = sdk;

    const server = new rpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    const source = new Account(Keypair.random().publicKey(), "0");
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        new Contract(config.contractId).call(
          fn,
          nativeToScVal(matchId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const simulation = await server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`simulation failed: ${simulation.error}`);
    }
    const retval = simulation.result?.retval;
    if (!retval) {
      throw new Error("simulation returned no value");
    }
    return sdk.scValToNative(retval);
  };
}

export function resolveNetworkPassphrase(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.STELLAR_NETWORK_PASSPHRASE?.trim();
  if (explicit) return explicit;

  const network = (env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase();
  switch (network) {
    case "testnet":
      return "Test SDF Network ; September 2015";
    case "mainnet":
    case "public":
      return "Public Global Stellar Network ; September 2015";
    case "futurenet":
      return "Test SDF Future Network ; October 2022";
    case "standalone":
      return "Standalone Network ; February 2017";
    default:
      throw new Error(
        `Unknown STELLAR_NETWORK "${network}". Set STELLAR_NETWORK_PASSPHRASE explicitly.`,
      );
  }
}

export interface ProviderFetchers {
  lichess: (gameId: string) => Promise<GameResult>;
  chessdotcom: (username: string, gameId: string) => Promise<GameResult>;
}

/** Fetch the game result straight from the chess platform, independently of the reporter. */
export function createProviderResultFetcher(
  fetchers: ProviderFetchers = {
    lichess: fetchLichessResult,
    chessdotcom: fetchChessDotComResult,
  },
): (input: MatchEvidenceInput) => Promise<GameResult> {
  return async (input) => {
    if (input.platform === "lichess") {
      return fetchers.lichess(input.gameId);
    }
    if (input.platform === "chessdotcom") {
      return fetchers.chessdotcom(input.player1Username, input.gameId);
    }
    throw new Error(`Unknown platform: ${input.platform}`);
  };
}

export interface ScheduledHandle {
  cancel: () => void;
}

export type Scheduler = (fn: () => void, delayMs: number) => ScheduledHandle;

const defaultScheduler: Scheduler = (fn, delayMs) => {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
};

export interface OutcomeDisagreementServiceOptions {
  sources: OutcomeEvidenceSources;
  config?: Partial<DisagreementMonitorConfig>;
  /** Delay before a completed match is checked, giving the result time to land on-chain. */
  checkDelayMs?: number;
  /** Total checks per match while evidence is still unavailable. */
  maxCheckAttempts?: number;
  schedule?: Scheduler;
  now?: () => number;
  onReviewSignal?: (status: MonitorStatus) => void;
}

export interface OutcomeDisagreementService {
  /** Queue a delayed, review-only check for a match whose game has completed. */
  scheduleCheck: (input: MatchEvidenceInput) => void;
  getStatus: () => MonitorStatus;
  /** Cancel pending checks. In-flight checks finish and are then discarded. */
  stop: () => void;
}

export function createOutcomeDisagreementService(
  options: OutcomeDisagreementServiceOptions,
): OutcomeDisagreementService {
  const monitor = new OutcomeDisagreementMonitor(
    options.sources,
    options.config,
    {
      now: options.now,
      onReviewSignal: options.onReviewSignal,
    },
  );
  const delayMs = options.checkDelayMs ?? DEFAULT_CHECK_DELAY_MS;
  const maxAttempts = options.maxCheckAttempts ?? DEFAULT_MAX_CHECK_ATTEMPTS;
  const schedule = options.schedule ?? defaultScheduler;

  const pending = new Set<ScheduledHandle>();
  const scheduled = new Set<number>();
  let stopped = false;

  const execute = async (
    input: MatchEvidenceInput,
    attempt: number,
  ): Promise<void> => {
    if (stopped) {
      scheduled.delete(input.matchId);
      return;
    }

    let observation: Observation;
    try {
      observation = await monitor.checkMatch(input);
    } catch (err) {
      logger.warn(
        {
          match_id: input.matchId,
          error: err instanceof Error ? err.message : String(err),
        },
        "outcome_disagreement_check_failed",
      );
      scheduled.delete(input.matchId);
      return;
    }

    const retryable =
      observation.kind === "unverifiable" &&
      observation.reason !== "identity_unmappable";
    if (retryable && attempt < maxAttempts && !stopped) {
      arm(input, attempt + 1);
      return;
    }
    scheduled.delete(input.matchId);
  };

  const arm = (input: MatchEvidenceInput, attempt: number): void => {
    const handle: ScheduledHandle = schedule(() => {
      pending.delete(handle);
      void execute(input, attempt);
    }, delayMs);
    pending.add(handle);
  };

  return {
    scheduleCheck(input) {
      if (stopped || scheduled.has(input.matchId)) return;
      scheduled.add(input.matchId);
      arm(input, 1);
    },
    getStatus: () => monitor.getStatus(),
    stop() {
      stopped = true;
      for (const handle of pending) handle.cancel();
      pending.clear();
      scheduled.clear();
    },
  };
}

function readPositiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${name}: must be a positive integer, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * Build the live service from environment variables. Returns null (with a log
 * line) when disabled or when the RPC URL or oracle contract id is missing.
 * Invalid threshold values throw, so a misconfigured deployment fails loudly.
 *
 *   OUTCOME_DISAGREEMENT_MONITOR_ENABLED     default true
 *   OUTCOME_DISAGREEMENT_CHECK_DELAY_MS      default 300000
 *   OUTCOME_DISAGREEMENT_MAX_CHECK_ATTEMPTS  default 3
 *   plus the threshold variables read by loadDisagreementMonitorConfig
 */
export function createOutcomeDisagreementServiceFromEnv(
  env: Record<string, string | undefined> = process.env,
): OutcomeDisagreementService | null {
  if (
    (env.OUTCOME_DISAGREEMENT_MONITOR_ENABLED ?? "true")
      .trim()
      .toLowerCase() === "false"
  ) {
    logger.info({}, "outcome_disagreement_monitor_disabled");
    return null;
  }

  const rpcUrl = env.STELLAR_RPC_URL?.trim();
  const contractId = env.CONTRACT_ORACLE?.trim();
  if (!rpcUrl || !contractId) {
    logger.warn(
      {
        has_rpc_url: Boolean(rpcUrl),
        has_oracle_contract: Boolean(contractId),
      },
      "outcome_disagreement_monitor_disabled_missing_config",
    );
    return null;
  }

  const config = loadDisagreementMonitorConfig(env);
  const networkPassphrase = resolveNetworkPassphrase(env);
  const fetchProvider = createProviderResultFetcher();

  const sources: OutcomeEvidenceSources = {
    readChainResult: createChainResultReader(
      createSdkContractInvoker({ rpcUrl, contractId, networkPassphrase }),
    ),
    fetchProviderResult: (input) =>
      withTimeout(
        fetchProvider(input),
        DEFAULT_PROVIDER_TIMEOUT_MS,
        "provider fetch",
      ),
  };

  logger.info({ config }, "outcome_disagreement_monitor_enabled");
  return createOutcomeDisagreementService({
    sources,
    config,
    checkDelayMs: readPositiveInt(
      env,
      "OUTCOME_DISAGREEMENT_CHECK_DELAY_MS",
      DEFAULT_CHECK_DELAY_MS,
    ),
    maxCheckAttempts: readPositiveInt(
      env,
      "OUTCOME_DISAGREEMENT_MAX_CHECK_ATTEMPTS",
      DEFAULT_MAX_CHECK_ATTEMPTS,
    ),
  });
}

export default createOutcomeDisagreementService;
