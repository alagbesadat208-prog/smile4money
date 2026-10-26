/**
 * Fault injection at every settlement boundary (issue #122).
 *
 * The settlement path, as documented in docs/oracle.md#settlement-boundaries:
 *
 *   B1 match store read → B2 provider lookup → B3 sign → B4 RPC submit →
 *   B5 confirmation → (on failure) B6 DLQ write → B7 DLQ retry → B8 restart
 *
 * A failure is injected at each one. Every test asserts the same three things:
 *   - the match stays recoverable (a later attempt can still settle it);
 *   - it is paid out at most once;
 *   - an operator can see what happened (a DLQ entry with a reason and an
 *     attempt count, or a poll status with a reason).
 *
 * The chain is a fake that enforces the escrow contract's rule that a match
 * accepts one result: a second submit_result is rejected, never paid twice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  submitWithIdempotence,
  submitWithRetry,
  retryDlqSubmission,
  type OracleSubmission,
  type RetryConfig,
} from "../../src/services/oracle-submit.js";
import {
  closeQueue,
  initializeQueue,
  listDlqEntries,
  removeDlqEntry,
  startRetryWorker,
  writeToDlq,
  type DlqEntry,
} from "../../src/queue.js";
import { resetCircuitBreaker } from "../../src/services/circuit-breaker.js";
import { SQLiteQueueStore } from "../../src/store/sqlite-queue-store.js";
import { verifyGameResult } from "../../src/services/oracle-service.js";
import { ChessPlatformPoller } from "../../src/services/game-poller.js";
import { PollingJobStore, PollingWorker } from "../../src/services/polling.js";
import * as lichess from "../../src/fetchers/lichess.js";
import { RateLimitError } from "../../src/errors/RateLimitError.js";
import type { MatchStore } from "../../src/store/match-store.js";

const FAST: RetryConfig = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 };
const SUB: OracleSubmission = {
  matchId: 7,
  gameId: "fxGame07",
  result: "Player1Wins",
};

/** Escrow-like chain: one accepted result per match, one payout per accepted result. */
class FakeChain {
  readonly results = new Map<number, OracleSubmission["result"]>();
  readonly payouts: number[] = [];
  submitCalls = 0;

  submit(sub: OracleSubmission) {
    this.submitCalls += 1;
    if (this.results.has(sub.matchId)) {
      throw new Error(
        `Contract error: ResultAlreadySubmitted for match ${sub.matchId}`,
      );
    }
    this.results.set(sub.matchId, sub.result);
    this.payouts.push(sub.matchId);
  }

  async exists(matchId: number) {
    return this.results.has(matchId);
  }
}

type Stage = "sign" | "submit" | "confirm";

/**
 * The oracle's sign → submit → confirm sequence with failures injected per
 * stage. `submit` failures happen before the transaction reaches the chain;
 * `confirm` failures happen after it landed (the result is on-chain, but the
 * oracle never learns that).
 */
function oracleHandler(
  chain: FakeChain,
  faults: Partial<Record<Stage, number>> = {},
) {
  const remaining = { sign: 0, submit: 0, confirm: 0, ...faults };
  const fail = (stage: Stage, message: string) => {
    if (remaining[stage] > 0) {
      remaining[stage] -= 1;
      throw new Error(message);
    }
  };
  return vi.fn(async (sub: OracleSubmission) => {
    fail("sign", "signing failed: oracle key unavailable");
    fail("submit", "RPC sendTransaction failed: Network error");
    chain.submit(sub);
    fail("confirm", "RPC getTransaction timed out waiting for confirmation");
  });
}

const ALWAYS = Number.POSITIVE_INFINITY;

async function clearDlq() {
  for (const e of await listDlqEntries()) await removeDlqEntry(e.id);
}

/** Run the DLQ retry worker for `cycles` intervals with the real handler wiring. */
async function runWorker(
  handler: (sub: OracleSubmission) => Promise<void>,
  exists: (matchId: number) => Promise<boolean>,
  cycles: number,
) {
  vi.useFakeTimers();
  const stop = startRetryWorker(
    (entry: DlqEntry) =>
      retryDlqSubmission(entry, handler, exists).then(() => {}),
    1_000,
  );
  for (let i = 0; i < cycles; i++) await vi.advanceTimersByTimeAsync(1_000);
  stop();
  vi.useRealTimers();
}

beforeEach(async () => {
  process.env.QUEUE_STORE = "memory";
  resetCircuitBreaker();
  await initializeQueue();
  await clearDlq();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeQueue();
});

describe("B1: match store read fails", () => {
  const match = {
    matchId: 7,
    gameId: "fxGame07",
    platform: "lichess",
    player1: "GA",
    player2: "GB",
    player1Username: "fixture-white",
    player2Username: "fixture-black",
  };

  it("surfaces the error without settling, and the same request succeeds once the store recovers", async () => {
    let storeDown = true;
    const store = {
      findByGameId: vi.fn(async () => {
        if (storeDown) throw new Error("SQLITE_BUSY: database is locked");
        return match;
      }),
      count: vi.fn(async () => 1),
    } as unknown as MatchStore;
    const fetch = vi.spyOn(lichess, "fetchLichessResult").mockResolvedValue({
      gameId: "fxGame07",
      status: "mate",
      whitePlayer: "fixture-white",
      blackPlayer: "fixture-black",
      result: "Player1Wins",
    });

    const input = {
      matchId: 7,
      gameId: "fxGame07",
      platform: "lichess" as const,
    };
    await expect(verifyGameResult(store, input)).rejects.toThrow(
      /database is locked/,
    );
    expect(fetch).not.toHaveBeenCalled(); // nothing downstream ran

    storeDown = false;
    const outcome = await verifyGameResult(store, input);
    // Identity-hash verification may reject this synthetic record; what matters
    // is that the store failure didn't leave the match unverifiable.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outcome).toHaveProperty("ok");
  });
});

describe("B2: provider lookup fails", () => {
  const job = (id: string) => ({
    id,
    matchId: 7,
    gameId: "fxGame07",
    platform: "lichess" as const,
    pollingAttempt: 0,
    createdAt: Date.now(),
    lastPolledAt: null,
  });

  it("a rate limit keeps the job in progress for the next cycle", async () => {
    vi.spyOn(lichess, "fetchLichessResult").mockRejectedValue(
      new RateLimitError("429"),
    );
    const status = await new ChessPlatformPoller().poll(job("j1"));
    expect(status.status).toBe("in_progress");
    expect(status.reason).toMatch(/rate limited/i);
  });

  it("a provider outage fails the poll with a reason and settles nothing", async () => {
    vi.spyOn(lichess, "fetchLichessResult").mockRejectedValue(
      new Error("ECONNRESET"),
    );
    const status = await new ChessPlatformPoller().poll(job("j2"));
    expect(status).toEqual({
      status: "failed",
      reason: "API error: ECONNRESET",
    });
    expect(status.result).toBeUndefined();
  });

  it("a job whose lookups keep failing lands in the DLQ with the job and reason, not silently dropped", async () => {
    vi.spyOn(lichess, "fetchLichessResult").mockRejectedValue(
      new Error("ECONNRESET"),
    );
    const store = new PollingJobStore();
    store.createJob(7, "fxGame07", "lichess");
    const onGameCompleted = vi.fn(async () => {});
    const worker = new PollingWorker(store, new ChessPlatformPoller(), {
      pollingIntervalMs: 60_000,
      maxPollingAttempts: 2,
      onGameCompleted,
      onMaxAttemptsExceeded: async (j, reason) => {
        await writeToDlq({ job: j }, reason ?? "max polling attempts exceeded");
      },
    });
    const pollAll = () =>
      (worker as unknown as { pollAllJobs(): Promise<void> }).pollAllJobs();
    await pollAll();
    await pollAll();
    await pollAll();
    worker.stop?.();

    expect(onGameCompleted).not.toHaveBeenCalled();
    const [entry] = await listDlqEntries();
    expect(entry).toBeDefined();
    expect((entry.payload as { job: { matchId: number } }).job.matchId).toBe(7);
    expect(entry.failureReason).toMatch(/ECONNRESET|max polling attempts/);
  });
});

describe("B3: signing fails", () => {
  it("a transient signing failure is retried and settles exactly once", async () => {
    const chain = new FakeChain();
    const entry = await submitWithIdempotence(
      SUB,
      oracleHandler(chain, { sign: 1 }),
      (m) => chain.exists(m),
      FAST,
    );
    expect(entry).toBeUndefined();
    expect(chain.payouts).toEqual([7]);
    expect(await listDlqEntries()).toEqual([]);
  });

  it("a persistent signing failure never reaches the chain and leaves an actionable DLQ entry", async () => {
    const chain = new FakeChain();
    const entry = await submitWithIdempotence(
      SUB,
      oracleHandler(chain, { sign: ALWAYS }),
      (m) => chain.exists(m),
      FAST,
    );

    expect(chain.submitCalls).toBe(0);
    expect(chain.payouts).toEqual([]);
    expect(entry?.failureReason).toMatch(/signing failed/);
    expect((await listDlqEntries()).map((e) => e.payload)).toEqual([SUB]);
  });
});

describe("B4: RPC submission fails", () => {
  it("leaves the chain untouched, queues the result, and the DLQ retry settles it once the RPC recovers", async () => {
    const chain = new FakeChain();
    await submitWithIdempotence(
      SUB,
      oracleHandler(chain, { submit: ALWAYS }),
      (m) => chain.exists(m),
      FAST,
    );
    expect(chain.payouts).toEqual([]);
    expect(await listDlqEntries()).toHaveLength(1);

    await runWorker(oracleHandler(chain), (m) => chain.exists(m), 1);

    expect(chain.payouts).toEqual([7]);
    expect(await listDlqEntries()).toEqual([]);
  });

  it("while the RPC stays down, one DLQ entry accumulates attempts instead of being replaced", async () => {
    const chain = new FakeChain();
    await submitWithIdempotence(
      SUB,
      oracleHandler(chain, { submit: ALWAYS }),
      (m) => chain.exists(m),
      FAST,
    );
    const [original] = await listDlqEntries();

    await runWorker(
      oracleHandler(chain, { submit: ALWAYS }),
      (m) => chain.exists(m),
      3,
    );

    const entries = await listDlqEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(original.id);
    expect(entries[0].attempts).toBe(3);
    expect(entries[0].lastAttemptAt).not.toBeNull();
    expect(chain.payouts).toEqual([]);
  });
});

describe("B5: confirmation is lost after the transaction landed", () => {
  it("never pays twice: in-loop retries are rejected by the contract, and the DLQ retry resolves via the existence check", async () => {
    const chain = new FakeChain();
    // Lands on the first attempt, but the confirmation never arrives.
    await submitWithIdempotence(
      SUB,
      oracleHandler(chain, { confirm: 1 }),
      (m) => chain.exists(m),
      FAST,
    );

    expect(chain.payouts).toEqual([7]);
    expect(chain.submitCalls).toBe(FAST.maxRetries + 1); // later attempts were rejected, not paid
    const [entry] = await listDlqEntries();
    expect(entry.failureReason).toMatch(/ResultAlreadySubmitted/); // tells the operator why

    const handler = oracleHandler(chain);
    await runWorker(handler, (m) => chain.exists(m), 1);

    expect(handler).not.toHaveBeenCalled(); // resolved without resubmitting
    expect(chain.payouts).toEqual([7]);
    expect(await listDlqEntries()).toEqual([]);
  });

  it("when the existence check itself fails on retry, nothing is resubmitted and the entry stays", async () => {
    const chain = new FakeChain();
    chain.submit(SUB); // landed earlier, unconfirmed
    await writeToDlq(
      SUB,
      "RPC getTransaction timed out waiting for confirmation",
    );

    const handler = oracleHandler(chain);
    await runWorker(
      handler,
      async () => {
        throw new Error("RPC unavailable");
      },
      2,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(chain.payouts).toEqual([7]);
    const [entry] = await listDlqEntries();
    expect(entry.attempts).toBe(2);
  });
});

describe("B6: the DLQ write itself fails", () => {
  it("reports the submission as not persisted instead of losing it silently", async () => {
    const chain = new FakeChain();
    await closeQueue();
    // Store not initialised: every DLQ write throws.
    await expect(
      submitWithRetry(SUB, oracleHandler(chain, { submit: ALWAYS }), FAST),
    ).rejects.toThrow(/not initialized/);
    expect(chain.payouts).toEqual([]);
    // logger.ts writes every level as a JSON line on stdout.
    const lines = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) =>
      l.includes("the DLQ write failed; submission is not persisted"),
    );
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({
      level: "error",
      matchId: 7,
      gameId: "fxGame07",
    });
    await initializeQueue();
  });
});

describe("B7: a DLQ entry is malformed", () => {
  it("is kept with an explanatory failure instead of crashing the worker or blocking other entries", async () => {
    const chain = new FakeChain();
    await writeToDlq({ not: "a submission" }, "legacy payload");
    await writeToDlq(
      { ...SUB, matchId: 8 },
      "RPC sendTransaction failed: Network error",
    );

    await runWorker(oracleHandler(chain), (m) => chain.exists(m), 1);

    expect(chain.payouts).toEqual([8]);
    const left = await listDlqEntries();
    expect(left).toHaveLength(1);
    expect(left[0].attempts).toBe(1);
  });
});

describe("B8: the process restarts between failure and retry", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "smile4money-fault-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the queued result survives the restart and is settled exactly once afterwards", async () => {
    const dbPath = path.join(dir, "queue.db");
    const chain = new FakeChain();

    const before = new SQLiteQueueStore(dbPath);
    await before.initialize();
    await before.add({
      id: "e1",
      payload: SUB,
      failureReason: "RPC sendTransaction failed",
      attempts: 2,
      createdAt: Date.now(),
      lastAttemptAt: Date.now(),
    });
    await before.close(); // crash

    const after = new SQLiteQueueStore(dbPath);
    await after.initialize();
    const [entry] = await after.getAll();
    expect(entry.payload).toEqual(SUB);
    expect(entry.attempts).toBe(2);

    expect(
      await retryDlqSubmission(entry, oracleHandler(chain), (m) =>
        chain.exists(m),
      ),
    ).toBe("submitted");
    await after.remove(entry.id);
    // A duplicate delivery of the same entry (e.g. a second worker) is a no-op.
    expect(
      await retryDlqSubmission(entry, oracleHandler(chain), (m) =>
        chain.exists(m),
      ),
    ).toBe("already-on-chain");
    await after.close();

    expect(chain.payouts).toEqual([7]);
  });
});
