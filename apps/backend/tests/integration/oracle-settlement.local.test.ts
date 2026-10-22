/** Real local Soroban integration. See docs/oracle-settlement.md for setup.
 * Only the external chess API is mocked; signing, simulation, submission,
 * confirmation, contract state and durable storage are real. */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { SettlementStore } from "../../src/store/settlement-store.js";
import { SqliteMatchStore } from "../../src/store/sqlite-match-store.js";
import { DurableOracleWorker } from "../../src/services/polling.js";
import { SorobanSettlementClient } from "../../src/services/oracle-submit.js";
import oracleRouter from "../../src/routes/oracle.js";

vi.mock("../../src/fetchers/lichess.js", () => ({
  GameNotFoundError: class extends Error {},
  fetchLichessResult: vi.fn(async (gameId: string) => ({
    gameId,
    status: "mate",
    whitePlayer: "alice",
    blackPlayer: "bob",
    result: "Player1Wins",
  })),
}));

const enabled = process.env.RUN_LOCAL_SOROBAN === "1";
const network = "Standalone Network ; February 2017";
const rpcUrl =
  process.env.LOCAL_SOROBAN_RPC_URL ?? "http://127.0.0.1:18000/soroban/rpc";
const friendbot =
  process.env.LOCAL_FRIENDBOT_URL ?? "http://127.0.0.1:18000/friendbot";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let dir: string | undefined;
let outbox: SettlementStore | undefined;
let source: SqliteMatchStore | undefined;
afterAll(async () => {
  await outbox?.close();
  await source?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("local Soroban oracle settlement", () => {
  it("submits a verified HTTP result, returns its hash, and confirms escrow PendingResult", async () => {
    const server = new rpc.Server(rpcUrl, { allowHttp: true, timeout: 10_000 });
    const admin = Keypair.random();
    const p1 = Keypair.random();
    const p2 = Keypair.random();
    for (const key of [admin, p1, p2]) {
      const response = await fetch(`${friendbot}?addr=${key.publicKey()}`);
      if (!response.ok)
        throw new Error(`Local friendbot failed: ${await response.text()}`);
    }
    async function invoke(
      key: Keypair,
      operation: xdr.Operation,
    ): Promise<xdr.ScVal> {
      const account = await server.getAccount(key.publicKey());
      const tx = await server.prepareTransaction(
        new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: network,
        })
          .addOperation(operation)
          .setTimeout(120)
          .build(),
      );
      tx.sign(key);
      const sent = await server.sendTransaction(tx);
      if (sent.status === "ERROR")
        throw new Error(
          `Local transaction rejected: ${sent.errorResult?.toXDR("base64")} ${JSON.stringify(sent.diagnosticEvents?.map((event) => event.toXDR("base64")))}`,
        );
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await server.getTransaction(tx.hash().toString("hex"));
        if (result.status === "SUCCESS") return result.returnValue!;
        if (result.status === "FAILED")
          throw new Error(
            `Local transaction failed: ${tx.hash().toString("hex")}`,
          );
        await sleep(500);
      }
      throw new Error("Local transaction confirmation timed out");
    }
    const wasm = await readFile(
      process.env.ESCROW_WASM_PATH ??
        resolve("../../target/wasm32v1-none/release/smile4money_escrow.optimized.wasm"),
    );
    const wasmHash = scValToNative(
      await invoke(admin, Operation.uploadContractWasm({ wasm })),
    ) as Buffer;
    const contractId = scValToNative(
      await invoke(
        admin,
        Operation.createCustomContract({
          address: new Address(admin.publicKey()),
          wasmHash,
          salt: randomBytes(32),
        }),
      ),
    ) as string;
    const contract = new Contract(contractId);
    const token = Asset.native().contractId(network);
    // Native SAC may already be deployed by a prior run on this local network.
    try {
      await invoke(
        admin,
        Operation.createStellarAssetContract({ asset: Asset.native() }),
      );
    } catch (error) {
      const probe = new Contract(token);
      await invoke(admin, probe.call("decimals"));
    }
    const address = (key: Keypair) => new Address(key.publicKey()).toScVal();
    const u64 = (id: number) => nativeToScVal(BigInt(id), { type: "u64" });
    await invoke(
      admin,
      contract.call(
        "initialize",
        address(admin),
        address(admin),
        new Address(token).toScVal(),
        address(admin),
        xdr.ScVal.scvVoid(),
        xdr.ScVal.scvVoid(),
      ),
    );
    dir = await mkdtemp(join(tmpdir(), "oracle-local-"));
    source = new SqliteMatchStore(join(dir, "matches.db"));
    outbox = new SettlementStore(
      join(dir, "settlements.db"),
      `${network}:${contractId}`,
    );
    await source.initialize();
    await outbox.initialize();
    // Reserve ID 0 so the HTTP request exercises the existing positive-ID API.
    for (const gameId of ["reserved-game", "verified-game"]) {
      await invoke(
        p1,
        contract.call(
          "create_match",
          address(p1),
          address(p2),
          nativeToScVal(100n, { type: "i128" }),
          xdr.ScVal.scvVoid(),
          nativeToScVal(gameId, { type: "string" }),
          xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Lichess")]),
        ),
      );
      await source.createMatch({
        player1: p1.publicKey(),
        player2: p2.publicKey(),
        player1Username: "alice",
        player2Username: "bob",
        stakeAmount: 100,
        token,
        gameId,
        platform: "lichess",
      });
    }
    for (const key of [p1, p2]) {
      await invoke(
        key,
        new Contract(token).call(
          "approve",
          address(key),
          new Address(contractId).toScVal(),
          nativeToScVal(100n, { type: "i128" }),
          nativeToScVal((await server.getHealth()).latestLedger + 1000, {
            type: "u32",
          }),
        ),
      );
    }
    await invoke(p1, contract.call("deposit", u64(1), address(p1)));
    await invoke(p2, contract.call("deposit", u64(1), address(p2)));
    const client = new SorobanSettlementClient({
      rpcUrl,
      networkPassphrase: network,
      secretKey: admin.secret(),
      escrowContract: contractId,
    });
    const worker = new DurableOracleWorker(source, outbox, client, 10);
    const app = express();
    app.use(express.json());
    app.locals.matchStore = source;
    app.locals.oracleWorker = worker;
    app.use("/api/oracle", oracleRouter);
    const auth = jwt.sign(
      { address: admin.publicKey() },
      process.env.JWT_SECRET ?? "test-secret",
    );
    const submit = () =>
      request(app)
        .post("/api/oracle/submit-result")
        .set("Authorization", `Bearer ${auth}`)
        .send({ matchId: 1, gameId: "verified-game", platform: "lichess" });
    const first = await submit();
    expect([200, 202]).toContain(first.status);
    expect(first.body.transactionHash).toMatch(/^[a-f0-9]{64}$/);
    let final = first;
    for (
      let attempt = 0;
      attempt < 100 && final.body.chainStatus !== "SUCCESS";
      attempt++
    ) {
      await sleep(500);
      await worker.cycle();
      final = await submit();
    }
    expect(final.status).toBe(200);
    expect(final.body).toMatchObject({
      transactionHash: first.body.transactionHash,
      chainStatus: "SUCCESS",
      settlementState: "confirmed",
    });
    expect((await client.getMatch(1)).state).toEqual(["PendingResult"]);
    expect(
      (await outbox.list()).filter((row) => row.matchId === 1),
    ).toHaveLength(1);
    console.log(
      JSON.stringify({
        transactionHash: final.body.transactionHash,
        chainStatus: final.body.chainStatus,
      }),
    );
  }, 180_000);
});
