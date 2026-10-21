import {
  Account,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  sponsorTransaction,
  type SponsorPolicy,
} from "../src/services/transaction-sponsor.js";
let directory: string;
let policy: SponsorPolicy;
const player = Keypair.random();
const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const now = Math.floor(Date.now() / 1000);
function transaction(
  sequence = "1",
  method = "deposit",
  passphrase = Networks.TESTNET,
  signer = player,
) {
  const tx = new TransactionBuilder(new Account(player.publicKey(), sequence), {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(
      new Contract(contractId).call(method, nativeToScVal(0, { type: "u64" })),
    )
    .setTimebounds(0, now + 120)
    .build();
  tx.sign(signer);
  return tx.toXDR();
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "sponsor-"));
  policy = {
    secret: Keypair.random().secret(),
    players: [player.publicKey()],
    contractId,
    baseFee: "1000",
    maxFee: 10000,
    dailyBudget: 20000,
    dailyPlayerLimit: 2,
    dbPath: path.join(directory, "sponsor.db"),
  };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const submit = () =>
  vi.fn(
    async (
      _tx: ReturnType<typeof TransactionBuilder.buildFeeBumpTransaction>,
    ) => ({ status: "PENDING", hash: "receipt" }),
  );
describe("testnet fee sponsorship", () => {
  it("preserves the signed inner transaction and signs only the outer fee bump", async () => {
    const send = submit();
    const signed = transaction();
    expect(await sponsorTransaction(signed, true, policy, send, now)).toEqual({
      hash: "receipt",
    });
    const outer = send.mock.calls[0][0];
    expect(outer.innerTransaction.toXDR()).toBe(signed);
    expect(outer.feeSource).toBe(Keypair.fromSecret(policy.secret).publicKey());
    expect(outer.signatures).toHaveLength(1);
  });
  it("rejects replay after restart, concurrent calls, and changed envelope with same sequence", async () => {
    const send = submit();
    const results = await Promise.allSettled([
      sponsorTransaction(transaction(), true, policy, send, now),
      sponsorTransaction(transaction(), true, { ...policy }, send, now),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    await expect(
      sponsorTransaction(
        transaction("1", "create_match"),
        true,
        policy,
        send,
        now,
      ),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("fails closed on opt-out, mainnet signatures, other signers, methods, players and fee caps", async () => {
    const send = submit();
    for (const [signed, optIn, limits] of [
      [transaction(), false, policy],
      [transaction("1", "deposit", Networks.PUBLIC), true, policy],
      [
        transaction("1", "deposit", Networks.TESTNET, Keypair.random()),
        true,
        policy,
      ],
      [transaction("1", "transfer"), true, policy],
      [transaction(), true, { ...policy, players: [] }],
      [transaction(), true, { ...policy, maxFee: 1 }],
    ] as const)
      await expect(
        sponsorTransaction(signed, optIn, limits, send, now),
      ).rejects.toThrow();
    await expect(
      sponsorTransaction(transaction(), true, policy, send, now + 121),
    ).rejects.toThrow("time bound");
    expect(send).not.toHaveBeenCalled();
  });
  it("enforces durable daily budgets and player quotas, retaining ambiguous failures", async () => {
    const send = submit();
    await sponsorTransaction(transaction("1"), true, policy, send, now);
    await expect(
      sponsorTransaction(
        transaction("2"),
        true,
        { ...policy, dailyBudget: 2000 },
        send,
        now,
      ),
    ).rejects.toThrow("budget");
    await expect(
      sponsorTransaction(
        transaction("2"),
        true,
        policy,
        async () => {
          throw new Error("timeout");
        },
        now,
      ),
    ).rejects.toThrow("timeout");
    await expect(
      sponsorTransaction(transaction("2"), true, policy, send, now),
    ).rejects.toThrow();
    await expect(
      sponsorTransaction(transaction("3"), true, policy, send, now),
    ).rejects.toThrow("limit");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
