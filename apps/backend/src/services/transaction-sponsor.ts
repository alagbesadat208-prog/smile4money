import {
  Address,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import sqlite3 from "sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface SponsorPolicy {
  secret: string;
  players: readonly string[];
  contractId: string;
  baseFee: string;
  maxFee: number;
  dailyBudget: number;
  dailyPlayerLimit: number;
  dbPath: string;
}
export function sponsorPolicy(): SponsorPolicy {
  if (process.env.FEE_SPONSOR_ENABLED !== "true")
    throw new Error("Fee sponsorship disabled");
  return {
    secret: process.env.FEE_SPONSOR_SECRET ?? "",
    players: (process.env.FEE_SPONSOR_PLAYERS ?? "").split(",").filter(Boolean),
    contractId:
      process.env.ESCROW_CONTRACT_ID ?? process.env.CONTRACT_ESCROW ?? "",
    baseFee: process.env.FEE_SPONSOR_BASE_FEE ?? "1000",
    maxFee: Number(process.env.FEE_SPONSOR_MAX_FEE ?? 1000000),
    dailyBudget: Number(process.env.FEE_SPONSOR_DAILY_BUDGET ?? 10000000),
    dailyPlayerLimit: Number(process.env.FEE_SPONSOR_DAILY_PLAYER_LIMIT ?? 10),
    dbPath: process.env.FEE_SPONSOR_DB ?? "data/fee-sponsor.db",
  };
}

/** Reserve the worst-case fee before network I/O; ambiguous failures stay spent.
 * UNIQUE(source, sequence) and hash guard concurrent calls and process restarts.
 */
async function reserve(
  policy: SponsorPolicy,
  hash: string,
  source: string,
  sequence: string,
  fee: number,
  now: number,
) {
  await mkdir(path.dirname(policy.dbPath), { recursive: true, mode: 0o700 });
  const db = new sqlite3.Database(policy.dbPath);
  db.configure("busyTimeout", 5000);
  const run = (sql: string, params: unknown[] = []) =>
    new Promise<void>((resolve, reject) =>
      db.run(sql, params, (error) => (error ? reject(error) : resolve())),
    );
  const get = (sql: string, params: unknown[]) =>
    new Promise<{ total: number; count: number }>((resolve, reject) =>
      db.get(sql, params, (error, row) =>
        error
          ? reject(error)
          : resolve(row as { total: number; count: number }),
      ),
    );
  try {
    await run(
      "CREATE TABLE IF NOT EXISTS sponsorships (hash TEXT PRIMARY KEY, source TEXT NOT NULL, sequence TEXT NOT NULL, day INTEGER NOT NULL, fee INTEGER NOT NULL, UNIQUE(source, sequence))",
    );
    await run("BEGIN IMMEDIATE");
    const day = Math.floor(now / 86400);
    const budget = await get(
      "SELECT COALESCE(SUM(fee), 0) AS total, COUNT(*) AS count FROM sponsorships WHERE day = ?",
      [day],
    );
    const player = await get(
      "SELECT COALESCE(SUM(fee), 0) AS total, COUNT(*) AS count FROM sponsorships WHERE day = ? AND source = ?",
      [day, source],
    );
    if (
      budget.total + fee > policy.dailyBudget ||
      player.count >= policy.dailyPlayerLimit
    )
      throw new Error("Sponsor budget or player limit exceeded");
    await run(
      "INSERT INTO sponsorships (hash, source, sequence, day, fee) VALUES (?, ?, ?, ?, ?)",
      [hash, source, sequence, day, fee],
    );
    await run("COMMIT");
  } catch (error) {
    await run("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await new Promise<void>((resolve, reject) =>
      db.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

export async function sponsorTransaction(
  signedTxXdr: string,
  optIn: boolean,
  policy: SponsorPolicy,
  submit: (
    tx: ReturnType<typeof TransactionBuilder.buildFeeBumpTransaction>,
  ) => Promise<{ status: string; hash: string }> = (tx) =>
    new rpc.Server("https://soroban-testnet.stellar.org").sendTransaction(tx),
  now = Math.floor(Date.now() / 1000),
) {
  if (optIn !== true) throw new Error("Explicit sponsorship opt-in required");
  if (
    ![
      policy.maxFee,
      policy.dailyBudget,
      policy.dailyPlayerLimit,
      Number(policy.baseFee),
    ].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new Error("Invalid sponsor limits");
  const sponsor = Keypair.fromSecret(policy.secret);
  const inner = TransactionBuilder.fromXDR(signedTxXdr, Networks.TESTNET);
  if (!(inner instanceof Transaction))
    throw new Error("Nested fee bump prohibited");
  if (
    !policy.players.includes(inner.source) ||
    inner.source === sponsor.publicKey()
  )
    throw new Error("Player not eligible for sponsorship");
  if (
    !inner.timeBounds ||
    Number(inner.timeBounds.maxTime) <= now ||
    Number(inner.timeBounds.maxTime) > now + 300 ||
    Number(inner.timeBounds.minTime) > now
  )
    throw new Error("A live time bound of at most 300 seconds is required");
  const player = Keypair.fromPublicKey(inner.source);
  if (
    !inner.signatures.some((signature) =>
      player.verify(inner.hash(), signature.signature()),
    )
  )
    throw new Error("Player signature invalid");
  if (inner.operations.length !== 1)
    throw new Error("Only one escrow operation is eligible");
  const operation = inner.operations[0];
  if (
    operation.type !== "invokeHostFunction" ||
    (operation.source && operation.source !== inner.source) ||
    operation.func.switch().name !== "hostFunctionTypeInvokeContract"
  )
    throw new Error("Only escrow contract calls are eligible");
  const call = operation.func.invokeContract();
  if (
    Address.fromScAddress(call.contractAddress()).toString() !==
      policy.contractId ||
    !["create_match", "deposit"].includes(call.functionName().toString())
  )
    throw new Error("Contract or method not eligible");
  const outer = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    policy.baseFee,
    inner,
    Networks.TESTNET,
  );
  const fee = Number(outer.fee);
  if (!Number.isSafeInteger(fee) || fee > policy.maxFee)
    throw new Error("Sponsor fee cap exceeded");
  await reserve(
    policy,
    inner.hash().toString("hex"),
    inner.source,
    inner.sequence,
    fee,
    now,
  );
  outer.sign(sponsor);
  const result = await submit(outer);
  if (result.status !== "PENDING" && result.status !== "DUPLICATE")
    throw new Error("Sponsored transaction rejected; reservation retained");
  return { hash: result.hash };
}
