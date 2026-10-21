/** Disposable Friendbot-funded accounts; no production credentials or persisted keys. */
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
const server = new Horizon.Server("https://horizon-testnet.stellar.org");
const sponsor = Keypair.random();
const player = Keypair.random();
for (const key of [sponsor, player]) {
  const response = await fetch(
    `https://friendbot.stellar.org?addr=${key.publicKey()}`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw new Error(`Friendbot failed (${response.status})`);
}
const asset = new Asset("REPLAYTEST", sponsor.publicKey());
async function submit(
  key: Keypair,
  operation: ReturnType<typeof Operation.payment>,
  sponsored = false,
) {
  const source = await server.loadAccount(key.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  tx.sign(key);
  if (sponsored) {
    const outer = TransactionBuilder.buildFeeBumpTransaction(
      sponsor,
      "1000",
      tx,
      Networks.TESTNET,
    );
    outer.sign(sponsor);
    const result = await server.submitTransaction(outer);
    console.log(
      JSON.stringify({
        mode: "sponsored",
        hash: result.hash,
        successful: result.successful,
      }),
    );
    // Same source sequence must not produce a second ledger effect.
    const repeated = await server.submitTransaction(outer);
    if (repeated.hash !== result.hash)
      throw new Error("Replay returned a different transaction");
    return result;
  }
  return server.submitTransaction(tx);
}
await submit(player, Operation.changeTrust({ asset }));
await submit(
  sponsor,
  Operation.payment({ destination: player.publicKey(), asset, amount: "10" }),
);
const direct = await submit(
  player,
  Operation.payment({ destination: sponsor.publicKey(), asset, amount: "1" }),
);
console.log(
  JSON.stringify({
    mode: "unsponsored",
    hash: direct.hash,
    successful: direct.successful,
  }),
);
const account = await server.loadAccount(player.publicKey());
const balance = account.balances.find((b) => b.asset_type === "native");
if (!balance || balance.asset_type !== "native")
  throw new Error("Native balance missing");
// Keep exactly the minimum balance for an account with one trustline (1.5 XLM).
const stroops = BigInt(balance.balance.replace(".", "")) - 15000000n - 100n;
const amount = `${stroops / 10000000n}.${(stroops % 10000000n).toString().padStart(7, "0")}`;
await submit(
  player,
  Operation.payment({
    destination: sponsor.publicKey(),
    asset: Asset.native(),
    amount,
  }),
);
try {
  await submit(
    player,
    Operation.payment({ destination: sponsor.publicKey(), asset, amount: "1" }),
  );
  throw new Error("Expected insufficient native fee balance");
} catch (error) {
  const codes = (
    error as {
      response?: {
        data?: { extras?: { result_codes?: { transaction?: string } } };
      };
    }
  ).response?.data?.extras?.result_codes;
  if (codes?.transaction !== "tx_insufficient_balance") throw error;
  console.log(
    JSON.stringify({
      mode: "unsponsored-without-fee-balance",
      rejected: codes.transaction,
    }),
  );
}
await submit(
  player,
  Operation.payment({ destination: sponsor.publicKey(), asset, amount: "1" }),
  true,
);
const final = await server.loadAccount(player.publicKey());
if (
  final.balances.find((b) => b.asset_type === "native")?.balance !== "1.5000000"
)
  throw new Error("Player was charged a native fee");
console.log(
  "PASS: player stake asset transferred; sponsor paid the fee; replay returned the same receipt.",
);
