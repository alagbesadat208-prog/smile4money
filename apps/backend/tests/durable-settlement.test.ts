import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettlementStore } from "../src/store/settlement-store.js";
import { SqliteMatchStore } from "../src/store/sqlite-match-store.js";
import { DurableOracleWorker } from "../src/services/polling.js";
import {
  advanceSettlement,
  type ChainMatch,
  type SettlementClient,
} from "../src/services/oracle-submit.js";
import {
  verifyGameResult,
  type SubmitResultSuccess,
} from "../src/services/oracle-service.js";

let dir: string;
let outbox: SettlementStore;
let source: SqliteMatchStore;
const verified: SubmitResultSuccess = {
  ok: true,
  verified: true,
  matchId: 0,
  gameId: "game-1",
  result: "Player1Wins",
  whitePlayer: "alice",
  blackPlayer: "bob",
  status: "mate",
  message: "verified",
};
let chain: ChainMatch;
let client: SettlementClient;
let verify: ReturnType<
  typeof vi.fn<
    Parameters<typeof verifyGameResult>,
    ReturnType<typeof verifyGameResult>
  >
>;
const makeWorker = () =>
  new DurableOracleWorker(source, outbox, client, 1, verify);
async function reopen() {
  await outbox.close();
  await source.close();
  outbox = new SettlementStore(join(dir, "settlements.db"), "local:escrow");
  source = new SqliteMatchStore(join(dir, "matches.db"));
  await outbox.initialize();
  await source.initialize();
}
async function due() {
  for (const record of await outbox.list()) {
    record.nextAttemptAt = 0;
    await outbox.save(record);
  }
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oracle-settlement-"));
  outbox = new SettlementStore(join(dir, "settlements.db"), "local:escrow");
  source = new SqliteMatchStore(join(dir, "matches.db"));
  await outbox.initialize();
  await source.initialize();
  await source.createMatch({
    player1: "G1",
    player2: "G2",
    player1Username: "alice",
    player2Username: "bob",
    stakeAmount: 100,
    token: "token",
    gameId: "game-1",
    platform: "lichess",
  });
  chain = {
    id: 0n,
    player1: "G1",
    player2: "G2",
    game_id: "game-1",
    platform: ["Lichess"],
    state: ["Active"],
  };
  client = {
    getMatch: vi.fn(async () => chain),
    prepare: vi.fn(async () => ({
      hash: "hash-1",
      envelope: "signed-xdr",
      expiresAt: Date.now() + 120_000,
    })),
    send: vi.fn(async () => {}),
    status: vi.fn(async () => "NOT_FOUND" as const),
  };
  verify = vi.fn<Parameters<typeof verifyGameResult>, ReturnType<typeof verifyGameResult>>(async () => ({ ...verified }));
});
afterEach(async () => {
  await outbox.close();
  await source.close();
  await rm(dir, { recursive: true, force: true });
});

describe("durable oracle workflow", () => {
  it("discovers persisted active matches after restart and enqueues exactly once", async () => {
    verify.mockResolvedValue({ ...verified, result: null });
    chain.state = ["Pending"];
    await makeWorker().cycle();
    expect(await outbox.list()).toHaveLength(0);
    chain.state = ["Active"];
    await reopen();
    const worker = makeWorker();
    await Promise.all([worker.cycle(), worker.cycle()]);
    expect(await outbox.list()).toHaveLength(1);
    expect((await outbox.list())[0].state).toBe("active");
  });

  it("rejects mismatched chain identity and does not enqueue", async () => {
    chain.player1 = "attacker";
    await makeWorker().cycle();
    expect(await outbox.list()).toHaveLength(0);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("persists a completed result before preparation, then recovers without refetching", async () => {
    vi.mocked(client.prepare).mockImplementationOnce(async () => {
      expect((await outbox.list())[0]).toMatchObject({
        state: "pending",
        submission: { result: "Player1Wins" },
      });
      throw new Error("RPC unavailable");
    });
    await makeWorker().cycle();
    await reopen();
    await due();
    vi.mocked(client.status)
      .mockResolvedValueOnce("NOT_FOUND")
      .mockResolvedValue("SUCCESS");
    await makeWorker().cycle();
    expect(verify).toHaveBeenCalledTimes(1);
    expect((await outbox.list())[0]).toMatchObject({
      state: "confirmed",
      chainStatus: "SUCCESS",
    });
    await makeWorker().cycle();
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("reconciles timeout-after-commit on restart without sending another transaction", async () => {
    vi.mocked(client.send).mockRejectedValueOnce(
      new Error("timeout after commit"),
    );
    await makeWorker().cycle();
    expect((await outbox.list())[0]).toMatchObject({
      state: "submitted",
      transaction: { hash: "hash-1" },
    });
    await reopen();
    await due();
    vi.mocked(client.status).mockResolvedValue("SUCCESS");
    await makeWorker().cycle();
    expect((await outbox.list())[0].state).toBe("confirmed");
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.prepare).toHaveBeenCalledTimes(1);
  });

  it("reconciles timeout-before-commit and rebroadcasts the identical signed envelope", async () => {
    vi.mocked(client.send).mockRejectedValueOnce(
      new Error("timeout before commit"),
    );
    await makeWorker().cycle();
    await reopen();
    await due();
    vi.mocked(client.status)
      .mockResolvedValueOnce("NOT_FOUND")
      .mockResolvedValueOnce("SUCCESS");
    await makeWorker().cycle();
    expect(client.send).toHaveBeenNthCalledWith(1, "signed-xdr");
    expect(client.send).toHaveBeenNthCalledWith(2, "signed-xdr");
    expect(client.prepare).toHaveBeenCalledTimes(1);
    expect((await outbox.list())[0].state).toBe("confirmed");
  });

  it("does not send if transaction status cannot be queried", async () => {
    vi.mocked(client.status).mockRejectedValue(new Error("RPC unavailable"));
    await makeWorker().cycle();
    expect(client.send).not.toHaveBeenCalled();
    expect((await outbox.list())[0].transaction?.hash).toBe("hash-1");
  });

  it("quarantines expired unknown transactions and retains their result and hash", async () => {
    vi.mocked(client.prepare).mockResolvedValue({
      hash: "expired",
      envelope: "xdr",
      expiresAt: 0,
    });
    await makeWorker().cycle();
    await reopen();
    await makeWorker().cycle();
    expect((await outbox.list())[0]).toMatchObject({
      state: "quarantined",
      submission: { result: "Player1Wins" },
      transaction: { hash: "expired" },
    });
    expect(client.send).not.toHaveBeenCalled();
  });

  it("retains failed transactions in quarantine and never repeats them", async () => {
    vi.mocked(client.status).mockResolvedValue("FAILED");
    await makeWorker().cycle();
    await makeWorker().cycle();
    expect((await outbox.list())[0]).toMatchObject({
      state: "quarantined",
      chainStatus: "FAILED",
    });
    expect(client.prepare).toHaveBeenCalledTimes(1);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("maps a white win to registered player2 when the players swap colors", async () => {
    verify.mockResolvedValue({
      ...verified,
      whitePlayer: "bob",
      blackPlayer: "alice",
    });
    await makeWorker().cycle();
    expect((await outbox.list())[0].submission?.result).toBe("Player2Wins");
  });

  it("does not broadcast when the signed transaction cannot be durably saved", async () => {
    await outbox.enqueue(0, "game-1");
    const record = (await outbox.list())[0];
    record.state = "pending";
    record.submission = { matchId: 0, gameId: "game-1", result: "Draw" };
    await outbox.save(record);
    vi.spyOn(outbox, "save").mockRejectedValueOnce(new Error("disk full"));
    await expect(advanceSettlement(outbox, client, record)).rejects.toThrow(
      "disk full",
    );
    expect(client.send).not.toHaveBeenCalled();
  });

  it("continues pending settlements even when the registration scan fails", async () => {
    await makeWorker().cycle();
    vi.spyOn(source, "listMatches").mockRejectedValue(
      new Error("scan unavailable"),
    );
    vi.mocked(client.status).mockResolvedValue("SUCCESS");
    await makeWorker().cycle();
    expect((await outbox.list())[0].state).toBe("confirmed");
  });

  it("isolates records by network and contract", async () => {
    await outbox.enqueue(0, "game-1");
    const other = new SettlementStore(
      join(dir, "settlements.db"),
      "other:escrow",
    );
    await other.initialize();
    expect(await other.list()).toEqual([]);
    await other.close();
  });
});

describe('serialized HTTP submissions', () => {
  it('concurrent requests for the same result submit exactly one transaction', async () => {
    vi.mocked(client.status).mockResolvedValueOnce('NOT_FOUND').mockResolvedValue('SUCCESS');
    const worker = makeWorker();
    const input = { matchId: 0, gameId: 'game-1', platform: 'lichess' };
    const results = await Promise.all([
      worker.submitVerified(input, verified), worker.submitVerified(input, verified),
    ]);
    expect(results.every(record => record.state === 'confirmed')).toBe(true);
    expect(client.prepare).toHaveBeenCalledTimes(1);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('does not allocate another sequence while a transaction remains uncertain', async () => {
    await makeWorker().cycle();
    await source.createMatch({ player1: 'G1', player2: 'G2', player1Username: 'alice', player2Username: 'bob',
      stakeAmount: 100, token: 'token', gameId: 'game-2', platform: 'lichess' });
    vi.mocked(client.getMatch).mockImplementation(async id => ({ ...chain, id: BigInt(id), game_id: id === 0 ? 'game-1' : 'game-2' }));
    const second = await makeWorker().submitVerified(
      { matchId: 1, gameId: 'game-2', platform: 'lichess' },
      { ...verified, matchId: 1, gameId: 'game-2' },
    );
    expect(second.state).toBe('pending');
    expect(second.transaction).toBeUndefined();
    expect(client.prepare).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched match ID before chain submission', async () => {
    await expect(makeWorker().submitVerified({ matchId: 100, gameId: 'game-1', platform: 'lichess' }, verified))
      .rejects.toThrow('matchId does not match');
    expect(client.send).not.toHaveBeenCalled();
    expect(await outbox.list()).toEqual([]);
  });
});
