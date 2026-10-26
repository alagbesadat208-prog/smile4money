import { afterEach, expect, it, vi } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  OracleContractTransport,
  oracleNetworkPassphrase,
} from "../src/services/oracle-contract.js";
const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const submission = { matchId: 42, gameId: "game_42", result: "Draw" as const };
afterEach(() => {
  vi.restoreAllMocks();
});

it("prepares and signs submit_result with the supplied current signer and waits for confirmation", async () => {
  const signer = Keypair.random();
  const server = {
    getAccount: vi.fn(async () => new Account(signer.publicKey(), "1")),
    prepareTransaction: vi.fn(async (tx) => tx),
    sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "hash" })),
    getTransaction: vi
      .fn()
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValue({ status: "SUCCESS" }),
  };
  const wait = vi.fn(async () => {});
  await new OracleContractTransport(
    server as any,
    contractId,
    Networks.TESTNET,
    wait,
  ).submit(submission, signer);
  const tx = server.prepareTransaction.mock.calls[0][0];
  expect(tx.source).toBe(signer.publicKey());
  const invoke = tx.operations[0].func.invokeContract();
  expect(invoke.functionName().toString()).toBe("submit_result");
  expect(invoke.args().map(scValToNative)).toEqual([42n, "game_42", ["Draw"]]);
  expect(signer.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
  expect(wait).toHaveBeenCalledOnce();
});

it.each(["ERROR", "TRY_AGAIN_LATER"])(
  "rejects RPC %s without reporting the durable job complete",
  async (status) => {
    const signer = Keypair.random();
    const server = {
      getAccount: vi.fn(async () => new Account(signer.publicKey(), "1")),
      prepareTransaction: vi.fn(async (tx) => tx),
      sendTransaction: vi.fn(async () => ({ status, hash: "hash" })),
    };
    await expect(
      new OracleContractTransport(
        server as any,
        contractId,
        Networks.TESTNET,
      ).submit(submission, signer),
    ).rejects.toThrow("rejected");
  },
);

it.each(["FAILED", "NOT_FOUND"])(
  "retains failed or ambiguously confirmed work (%s)",
  async (status) => {
    const signer = Keypair.random();
    const server = {
      getAccount: vi.fn(async () => new Account(signer.publicKey(), "1")),
      prepareTransaction: vi.fn(async (tx) => tx),
      sendTransaction: vi.fn(async () => ({
        status: "DUPLICATE",
        hash: "hash",
      })),
      getTransaction: vi.fn(async () => ({ status })),
    };
    await expect(
      new OracleContractTransport(
        server as any,
        contractId,
        Networks.TESTNET,
        async () => {},
      ).submit(submission, signer),
    ).rejects.toThrow(status === "FAILED" ? "failed" : "pending");
  },
);

it.each([true, false])(
  "reads has_result (%s) without signing",
  async (exists) => {
    const server = {
      simulateTransaction: vi.fn(async (_transaction: Transaction) => ({
        transactionData: {},
        result: { retval: xdr.ScVal.scvBool(exists) },
      })),
    };
    expect(
      await new OracleContractTransport(
        server as any,
        contractId,
        Networks.TESTNET,
      ).hasResult(42),
    ).toBe(exists);
    const tx = server.simulateTransaction.mock.calls[0][0];
    expect(tx.signatures).toHaveLength(0);
    const operation = tx.operations[0];
    if (operation.type !== "invokeHostFunction")
      throw new Error("Expected contract invocation");
    expect(operation.func.invokeContract().functionName().toString()).toBe(
      "has_result",
    );
  },
);

it("fails closed on a failed existence lookup and refuses an unknown network", async () => {
  const server = {
    simulateTransaction: vi.fn(async (_transaction: Transaction) => ({
      error: "provider secret error",
    })),
  };
  await expect(
    new OracleContractTransport(
      server as any,
      contractId,
      Networks.TESTNET,
    ).hasResult(42),
  ).rejects.toThrow("lookup failed");
  expect(() => oracleNetworkPassphrase({ STELLAR_NETWORK: "unknown" })).toThrow(
    "PASSPHRASE",
  );
  expect(oracleNetworkPassphrase({ STELLAR_NETWORK: "mainnet" })).toBe(
    Networks.PUBLIC,
  );
});
