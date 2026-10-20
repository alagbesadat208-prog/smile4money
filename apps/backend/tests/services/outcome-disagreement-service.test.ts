import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/fetchers/lichess.js", () => ({
  fetchLichessResult: vi.fn(),
  GameNotFoundError: class GameNotFoundError extends Error {},
}));

vi.mock("../../src/fetchers/chessdotcom.js", () => ({
  fetchChessDotComResult: vi.fn(),
  RateLimitError: class RateLimitError extends Error {},
}));

const sdk = vi.hoisted(() => {
  const state = {
    simulateImpl: vi.fn(),
    serverArgs: [] as unknown[],
    contractIds: [] as string[],
  };
  class Contract {
    constructor(id: string) {
      state.contractIds.push(id);
    }
    call(fn: string, ...args: unknown[]) {
      return { fn, args };
    }
  }
  class Account {
    constructor(
      public id: string,
      public sequence: string,
    ) {}
  }
  class TransactionBuilder {
    ops: unknown[] = [];
    constructor(
      public account: unknown,
      public opts: unknown,
    ) {}
    addOperation(op: unknown) {
      this.ops.push(op);
      return this;
    }
    setTimeout(_seconds: number) {
      return this;
    }
    build() {
      return { ops: this.ops, opts: this.opts };
    }
  }
  class Server {
    constructor(url: string, opts: unknown) {
      state.serverArgs.push([url, opts]);
    }
    simulateTransaction(tx: unknown) {
      return state.simulateImpl(tx);
    }
  }
  const module = {
    Contract,
    Account,
    TransactionBuilder,
    BASE_FEE: "100",
    Keypair: { random: () => ({ publicKey: () => "GRANDOM" }) },
    nativeToScVal: (value: unknown, opts: unknown) => ({ native: value, opts }),
    scValToNative: (value: { native: unknown }) => value.native,
    rpc: {
      Server,
      Api: { isSimulationError: (sim: object) => "error" in sim },
    },
  };
  return { state, module };
});

vi.mock("@stellar/stellar-sdk", () => sdk.module);

import { fetchLichessResult } from "../../src/fetchers/lichess.js";
import { fetchChessDotComResult } from "../../src/fetchers/chessdotcom.js";
import type { GameResult, MatchResult } from "../../src/fetchers/lichess.js";
import type {
  MatchEvidenceInput,
  OutcomeEvidenceSources,
} from "../../src/services/outcome-disagreement-monitor.js";
import {
  createChainResultReader,
  createOutcomeDisagreementService,
  createOutcomeDisagreementServiceFromEnv,
  createProviderResultFetcher,
  createSdkContractInvoker,
  decodeMatchResult,
  decodeResultEntry,
  resolveNetworkPassphrase,
} from "../../src/services/outcome-disagreement-service.js";
import type { ContractInvoker } from "../../src/services/outcome-disagreement-service.js";

const HOUR = 60 * 60 * 1000;

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

function evidence(matchId: number, platform = "lichess"): MatchEvidenceInput {
  return {
    matchId,
    gameId: `game-${matchId}`,
    platform,
    player1Username: "Alice",
    player2Username: "Bob",
  };
}

function manualScheduler() {
  const tasks: {
    fn: () => void;
    ms: number;
    cancelled: boolean;
    ran: boolean;
  }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const task = { fn, ms, cancelled: false, ran: false };
    tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      },
    };
  };
  const runNext = async () => {
    const task = tasks.find((t) => !t.cancelled && !t.ran);
    if (!task) return false;
    task.ran = true;
    task.fn();
    await new Promise((r) => setTimeout(r, 0));
    return true;
  };
  return { tasks, schedule, runNext };
}

function createSources() {
  const fetchProviderResult = vi.fn();
  const readChainResult = vi.fn();
  const sources: OutcomeEvidenceSources = {
    fetchProviderResult,
    readChainResult,
  };
  return { sources, fetchProviderResult, readChainResult };
}

const CFG = {
  windowSize: 10,
  maxAgeMs: HOUR,
  minDecided: 2,
  minDisagreements: 2,
  minDisagreementRate: 0.5,
};

beforeEach(() => {
  vi.clearAllMocks();
  sdk.state.simulateImpl.mockReset();
  sdk.state.serverArgs.length = 0;
  sdk.state.contractIds.length = 0;
});

describe("decoding", () => {
  it("decodes a match result from a string or a one-element array", () => {
    expect(decodeMatchResult("Player1Wins")).toBe("Player1Wins");
    expect(decodeMatchResult(["Draw"])).toBe("Draw");
    expect(decodeMatchResult(["Player2Wins"])).toBe("Player2Wins");
  });

  it("rejects unknown match result values", () => {
    expect(() => decodeMatchResult("Nobody")).toThrow(
      /Unexpected match result/,
    );
    expect(() => decodeMatchResult(undefined)).toThrow(
      /Unexpected match result/,
    );
  });

  it("decodes a result entry from an object or a Map", () => {
    expect(
      decodeResultEntry({
        game_id: "x",
        result: ["Player1Wins"],
        submitted_ledger: 5,
      }),
    ).toBe("Player1Wins");
    expect(decodeResultEntry(new Map([["result", "Draw"]]))).toBe("Draw");
  });

  it("rejects entries that are not objects", () => {
    expect(() => decodeResultEntry(null)).toThrow(/Unexpected result entry/);
    expect(() => decodeResultEntry("Draw")).toThrow(/Unexpected result entry/);
  });
});

describe("createChainResultReader", () => {
  it("returns null without calling get_result when no result exists", async () => {
    const invoke = vi.fn<
      Parameters<ContractInvoker>,
      ReturnType<ContractInvoker>
    >();
    invoke.mockResolvedValueOnce(false);

    const result = await createChainResultReader(invoke)(7);

    expect(result).toBeNull();
    expect(invoke.mock.calls).toEqual([["has_result", 7]]);
  });

  it("returns the recorded outcome when a result exists", async () => {
    const invoke = vi.fn<
      Parameters<ContractInvoker>,
      ReturnType<ContractInvoker>
    >();
    invoke.mockResolvedValueOnce(true);
    invoke.mockResolvedValueOnce({
      game_id: "x",
      result: ["Player2Wins"],
      submitted_ledger: 9,
    });

    const result = await createChainResultReader(invoke)(7);

    expect(result).toBe("Player2Wins");
    expect(invoke.mock.calls).toEqual([
      ["has_result", 7],
      ["get_result", 7],
    ]);
  });

  it("only ever calls read-only contract functions", async () => {
    const invoke = vi.fn<
      Parameters<ContractInvoker>,
      ReturnType<ContractInvoker>
    >();
    invoke.mockResolvedValueOnce(true);
    invoke.mockResolvedValueOnce({ result: "Draw" });

    await createChainResultReader(invoke)(1);

    const names = invoke.mock.calls.map((c) => c[0]);
    expect(names.every((n) => n === "has_result" || n === "get_result")).toBe(
      true,
    );
  });

  it("throws on an unexpected has_result value", async () => {
    const invoke: ContractInvoker = async () => "yes";
    await expect(createChainResultReader(invoke)(1)).rejects.toThrow(
      /Unexpected has_result/,
    );
  });

  it("propagates invoker failures", async () => {
    const invoke: ContractInvoker = async () => {
      throw new Error("rpc down");
    };
    await expect(createChainResultReader(invoke)(1)).rejects.toThrow(
      "rpc down",
    );
  });

  it("times out a hanging RPC call", async () => {
    const invoke: ContractInvoker = () => new Promise(() => undefined);
    await expect(
      createChainResultReader(invoke, { timeoutMs: 20 })(1),
    ).rejects.toThrow(/timed out/);
  });
});

describe("createSdkContractInvoker", () => {
  const config = {
    rpcUrl: "https://rpc.test",
    contractId: "CORACLE",
    networkPassphrase: "Test",
  };

  it("simulates a read-only call and decodes the return value", async () => {
    sdk.state.simulateImpl.mockResolvedValue({
      result: { retval: { native: true } },
    });

    const value = await createSdkContractInvoker(config)("has_result", 7);

    expect(value).toBe(true);
    expect(sdk.state.serverArgs[0]).toEqual([
      "https://rpc.test",
      { allowHttp: false },
    ]);
    expect(sdk.state.contractIds).toEqual(["CORACLE"]);
    const tx = sdk.state.simulateImpl.mock.calls[0][0] as { ops: unknown[] };
    expect(tx.ops).toEqual([
      { fn: "has_result", args: [{ native: 7, opts: { type: "u64" } }] },
    ]);
  });

  it("allows plain http only for http RPC urls", async () => {
    sdk.state.simulateImpl.mockResolvedValue({
      result: { retval: { native: false } },
    });

    await createSdkContractInvoker({
      ...config,
      rpcUrl: "http://localhost:8000",
    })("has_result", 1);

    expect(sdk.state.serverArgs[0]).toEqual([
      "http://localhost:8000",
      { allowHttp: true },
    ]);
  });

  it("throws when the simulation reports an error", async () => {
    sdk.state.simulateImpl.mockResolvedValue({ error: "boom" });
    await expect(
      createSdkContractInvoker(config)("get_result", 1),
    ).rejects.toThrow(/simulation failed: boom/);
  });

  it("throws when the simulation returns no value", async () => {
    sdk.state.simulateImpl.mockResolvedValue({ result: {} });
    await expect(
      createSdkContractInvoker(config)("get_result", 1),
    ).rejects.toThrow(/no value/);
  });
});

describe("resolveNetworkPassphrase", () => {
  it("maps known networks and defaults to testnet", () => {
    expect(resolveNetworkPassphrase({})).toBe(
      "Test SDF Network ; September 2015",
    );
    expect(resolveNetworkPassphrase({ STELLAR_NETWORK: "mainnet" })).toBe(
      "Public Global Stellar Network ; September 2015",
    );
  });

  it("prefers an explicit passphrase", () => {
    expect(
      resolveNetworkPassphrase({
        STELLAR_NETWORK: "testnet",
        STELLAR_NETWORK_PASSPHRASE: "Custom",
      }),
    ).toBe("Custom");
  });

  it("throws for an unknown network", () => {
    expect(() =>
      resolveNetworkPassphrase({ STELLAR_NETWORK: "nonsense" }),
    ).toThrow(/STELLAR_NETWORK/);
  });
});

describe("createProviderResultFetcher", () => {
  it("uses the Lichess fetcher with the game id", async () => {
    const result = game("Alice", "Bob", "Player1Wins");
    vi.mocked(fetchLichessResult).mockResolvedValue(result);

    const fetched = await createProviderResultFetcher()(evidence(1, "lichess"));

    expect(fetched).toBe(result);
    expect(fetchLichessResult).toHaveBeenCalledWith("game-1");
  });

  it("uses the Chess.com fetcher with the Player 1 username", async () => {
    const result = game("Alice", "Bob", "Draw");
    vi.mocked(fetchChessDotComResult).mockResolvedValue(result);

    const fetched = await createProviderResultFetcher()(
      evidence(2, "chessdotcom"),
    );

    expect(fetched).toBe(result);
    expect(fetchChessDotComResult).toHaveBeenCalledWith("Alice", "game-2");
  });

  it("rejects an unknown platform", async () => {
    await expect(
      createProviderResultFetcher()(evidence(3, "other")),
    ).rejects.toThrow(/Unknown platform/);
  });
});

describe("createOutcomeDisagreementService", () => {
  it("does not check immediately, only after the scheduled delay", async () => {
    const { sources, readChainResult } = createSources();
    const scheduler = manualScheduler();
    const service = createOutcomeDisagreementService({
      sources,
      config: CFG,
      checkDelayMs: 1234,
      schedule: scheduler.schedule,
    });

    service.scheduleCheck(evidence(1));

    expect(scheduler.tasks).toHaveLength(1);
    expect(scheduler.tasks[0].ms).toBe(1234);
    expect(readChainResult).not.toHaveBeenCalled();
  });

  it("records the observation once the check runs", async () => {
    const { sources, readChainResult, fetchProviderResult } = createSources();
    readChainResult.mockResolvedValue("Player1Wins");
    fetchProviderResult.mockResolvedValue(game("Alice", "Bob", "Player1Wins"));
    const scheduler = manualScheduler();
    const service = createOutcomeDisagreementService({
      sources,
      config: CFG,
      schedule: scheduler.schedule,
    });

    service.scheduleCheck(evidence(1));
    await scheduler.runNext();

    const status = service.getStatus();
    expect(status.agreements).toBe(1);
    expect(status.disagreements).toBe(0);
    expect(await scheduler.runNext()).toBe(false);
  });

  it("ignores a second check request for the same match while one is pending", () => {
    const { sources } = createSources();
    const scheduler = manualScheduler();
    const service = createOutcomeDisagreementService({
      sources,
      config: CFG,
      schedule: scheduler.schedule,
    });

    service.scheduleCheck(evidence(1));
    service.scheduleCheck(evidence(1));

    expect(scheduler.tasks).toHaveLength(1);
  });

  it("retries while no chain result exists, up to the attempt limit", async () => {
    const { sources, readChainResult } = createSources();
    readChainResult.mockResolvedValue(null);
    const scheduler = manualScheduler();
    const service = createOutcomeDisagreementService({
      sources,
      config: CFG,
      maxCheckAttempts: 3,
      schedule: scheduler.schedule,
    });

    service.scheduleCheck(evidence(1));
    while (await scheduler.runNext()) {
      // drain every scheduled attempt
    }

    expect(readChainResult).toHaveBeenCalledTimes(3);
    const status = service.getStatus();
    expect(status.unverifiable).toBe(1);
    expect(status.disagreements).toBe(0);
  });

  it("stops retrying once the evidence is decided", async () => {
    const { sources, readChainResult, fetchProviderResult } = createSources();
    readChainResult
      .mockResolvedValueOnce(null)
      .mockResolvedValue("Player1Wins");
    fetchProviderResult.mockResolvedValue(game("Alice", "Bob", "Player1Wins"));
    const scheduler = manualScheduler();
    const service = createOutcomeDisagreementService({
      sources,
      config: CFG,
      maxCheckAttempts: 5,
      schedule: scheduler.schedule,
    });

    service.scheduleCheck(evidence(1));
    while (await scheduler.runNext()) {
      // drain every scheduled attempt
    }

    expect(readChainResult).toHaveBeenCalledTimes(2);
    expect(service.getStatus().agreements).toBe(1);
  });

  it("does not retry an unmappable identity", async () => {
    const { sources, readChainResult, fetchProviderResult } = createSources();
    readChainResult.mockResolvedValue("Player1Wins");
    fetchProviderResult.mockResolvedValue(game("Carol", "Dave", "Player1Wins"));
    const scheduler = manualScheduler();
    const service = createOutcomeDisagreementService({
      sources,
      config: CFG,
      maxCheckAttempts: 3,
      schedule: scheduler.schedule,
    });

    service.scheduleCheck(evidence(1));
    while (await scheduler.runNext()) {
      // drain every scheduled attempt
    }

    expect(readChainResult).toHaveBeenCalledTimes(1);
  });

  it("raises the review signal after sustained disagreement", async () => {
    const { sources, readChainResult, fetchProviderResult } = createSources();
    readChainResult.mockResolvedValue("Player2Wins");
    fetchProviderResult.mockResolvedValue(game("Alice", "Bob", "Player1Wins"));
    const onReviewSignal = vi.fn();
    const scheduler = manualScheduler();
    const service = createOutcomeDisagreementService({
      sources,
      config: CFG,
      schedule: scheduler.schedule,
      onReviewSignal,
    });

    service.scheduleCheck(evidence(1));
    service.scheduleCheck(evidence(2));
    while (await scheduler.runNext()) {
      // drain every scheduled attempt
    }

    expect(onReviewSignal).toHaveBeenCalledTimes(1);
    expect(onReviewSignal).toHaveBeenCalledWith(
      expect.objectContaining({ reviewRequired: true, disagreements: 2 }),
    );
  });

  it("cancels pending checks on stop and ignores later requests", () => {
    const { sources } = createSources();
    const scheduler = manualScheduler();
    const service = createOutcomeDisagreementService({
      sources,
      config: CFG,
      schedule: scheduler.schedule,
    });

    service.scheduleCheck(evidence(1));
    service.stop();
    service.scheduleCheck(evidence(2));

    expect(scheduler.tasks).toHaveLength(1);
    expect(scheduler.tasks[0].cancelled).toBe(true);
  });
});

describe("createOutcomeDisagreementServiceFromEnv", () => {
  const baseEnv = {
    STELLAR_RPC_URL: "https://rpc.test",
    CONTRACT_ORACLE: "CORACLE",
    STELLAR_NETWORK: "testnet",
  };

  it("returns null when disabled", () => {
    expect(
      createOutcomeDisagreementServiceFromEnv({
        ...baseEnv,
        OUTCOME_DISAGREEMENT_MONITOR_ENABLED: "false",
      }),
    ).toBeNull();
  });

  it("returns null when the RPC url or oracle contract is missing", () => {
    expect(
      createOutcomeDisagreementServiceFromEnv({ CONTRACT_ORACLE: "CORACLE" }),
    ).toBeNull();
    expect(
      createOutcomeDisagreementServiceFromEnv({ STELLAR_RPC_URL: "https://x" }),
    ).toBeNull();
  });

  it("builds a service without touching the network", () => {
    const service = createOutcomeDisagreementServiceFromEnv(baseEnv);

    expect(service).not.toBeNull();
    expect(service?.getStatus().windowObservations).toBe(0);
    service?.stop();
  });

  it("fails loudly on invalid configuration", () => {
    expect(() =>
      createOutcomeDisagreementServiceFromEnv({
        ...baseEnv,
        STELLAR_NETWORK: "nonsense",
      }),
    ).toThrow(/STELLAR_NETWORK/);
    expect(() =>
      createOutcomeDisagreementServiceFromEnv({
        ...baseEnv,
        OUTCOME_DISAGREEMENT_CHECK_DELAY_MS: "0",
      }),
    ).toThrow(/OUTCOME_DISAGREEMENT_CHECK_DELAY_MS/);
    expect(() =>
      createOutcomeDisagreementServiceFromEnv({
        ...baseEnv,
        OUTCOME_DISAGREEMENT_MIN_RATE: "2",
      }),
    ).toThrow(/minDisagreementRate/);
  });
});

describe("safety: read only", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/services/outcome-disagreement-service.ts"),
    "utf8",
  );

  it("never broadcasts or signs and never names the submission function", () => {
    expect(source).not.toMatch(
      /sendTransaction|submit_result|\.sign\(|signTransaction/,
    );
  });

  it("imports no submission, queue, polling or store code", () => {
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line) || /\bfrom\s+'/.test(line))
      .join("\n");

    expect(importLines).not.toMatch(
      /oracle-submit|oracle-service|queue|polling|match-store|escrow|services\/stellar/i,
    );
  });
});
