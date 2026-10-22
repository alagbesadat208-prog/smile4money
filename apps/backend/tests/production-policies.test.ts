import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { SQLiteQueueStore } from "../src/store/sqlite-queue-store.js";
import { SqliteMatchStore } from "../src/store/sqlite-match-store.js";
import { sqliteSettings } from "../src/store/sqlite-config.js";
import { unlinkPlayerIdentities } from "../src/services/player-identity.js";
import {
  ManagedSignerProvider,
  managedSubmissionHandler,
} from "../src/services/oracle-signer.js";
import { readFile } from "node:fs/promises";
import { retryDlqEntry } from "../src/services/oracle-submit.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SQLite production concurrency", () => {
  it("persists simultaneous writes through independent connections with WAL and busy timeout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oracle-concurrency-"));
    const stores = [
      new SQLiteQueueStore(path.join(dir, "queue.db")),
      new SQLiteQueueStore(path.join(dir, "queue.db")),
    ];
    try {
      for (const store of stores) await store.initialize();
      await Promise.all(
        Array.from({ length: 40 }, (_, n) =>
          stores[n % 2].add({
            id: String(n),
            payload: { matchId: n },
            failureReason: "pending",
            attempts: 0,
            createdAt: Date.now(),
            lastAttemptAt: null,
          }),
        ),
      );
      expect(await stores[0].count()).toBe(40);
      const db = (stores[0] as any).db;
      const pragma = (name: string) =>
        new Promise<any>((resolve, reject) =>
          db.get(`PRAGMA ${name}`, (err: Error, row: unknown) =>
            err ? reject(err) : resolve(row),
          ),
        );
      expect(await pragma("journal_mode")).toEqual({ journal_mode: "wal" });
      expect(await pragma("busy_timeout")).toEqual({ timeout: 5000 });
    } finally {
      for (const store of stores) await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["BACKEND_REPLICAS", "WEB_CONCURRENCY"])(
    "refuses startup for %s > 1",
    async (key) => {
      vi.stubEnv(key, "2");
      await expect(
        new SQLiteQueueStore(":memory:").initialize(),
      ).rejects.toThrow("multiple backend writers");
      await expect(
        new SqliteMatchStore(":memory:").initialize(),
      ).rejects.toThrow("multiple backend writers");
    },
  );
  it("rejects unsupported mode and malformed timeout", () => {
    expect(() =>
      sqliteSettings({ SQLITE_CONCURRENCY_MODE: "multi-replica" }),
    ).toThrow("single-process");
    expect(() => sqliteSettings({ SQLITE_BUSY_TIMEOUT_MS: "50ms" })).toThrow(
      "SQLITE_BUSY_TIMEOUT_MS",
    );
  });
});

it("unlinks identities durably without changing settlement fields or other wallets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-unlink-"));
  let store = new SqliteMatchStore(path.join(dir, "matches.db"));
  try {
    await store.initialize();
    const payload = {
      player1: "wallet-a",
      player2: "wallet-b",
      player1Username: "alice",
      player2Username: "bob",
      stakeAmount: 10,
      token: "token",
      gameId: "game-a",
      platform: "lichess",
    };
    const original = await store.createMatch(payload);
    await store.createMatch({
      ...payload,
      player1: "wallet-c",
      player2: "wallet-d",
      gameId: "game-b",
    });
    expect(await unlinkPlayerIdentities(store, "stranger")).toBe(0);
    expect(await unlinkPlayerIdentities(store, "wallet-a")).toBe(1);
    expect(await unlinkPlayerIdentities(store, "wallet-a")).toBe(0);
    await store.close();
    store = new SqliteMatchStore(path.join(dir, "matches.db"));
    await store.initialize();
    expect(await store.findByGameId("game-a")).toEqual({
      ...original,
      player1Username: undefined,
      player2Username: undefined,
      identityHash: undefined,
    });
    expect((await store.findByGameId("game-b"))?.player1Username).toBe("alice");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("rotates a mounted signer while durable work remains unchanged and rejects unauthorized keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-rotation-"));
  const file = path.join(dir, "signer");
  const oldKey = Keypair.random(),
    newKey = Keypair.random();
  let admin = oldKey.publicKey();
  const provider = new ManagedSignerProvider(
    () => readFile(file, "utf8"),
    async () => admin,
  );
  const store = new SQLiteQueueStore(path.join(dir, "queue.db"));
  try {
    await writeFile(file, oldKey.secret());
    await provider.getAuthorizedSigner(); // startup gate
    await store.initialize();
    const entry = {
      id: "pending",
      payload: { matchId: 1, gameId: "game", result: "Draw" },
      attempts: 0,
      createdAt: Date.now(),
      lastAttemptAt: null,
      failureReason: "RPC unavailable",
    };
    await store.add(entry);
    const submit = vi.fn(async (_submission: unknown, _signer: Keypair) => {});
    const handler = managedSubmissionHandler(provider, submit);
    admin = newKey.publicKey();
    expect(await retryDlqEntry((await store.getAll())[0], handler)).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(await store.count()).toBe(1);
    await writeFile(file, newKey.secret());
    expect(await retryDlqEntry((await store.getAll())[0], handler)).toBe(true);
    expect(submit.mock.calls[0][1].publicKey()).toBe(newKey.publicKey());
    expect((await store.getAll())[0].payload).toEqual(entry.payload);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("reads the active on-chain role, not a pending transfer proposal", async () => {
  const { readOracleAdmin } = await import("../src/services/oracle-signer.js");
  const { xdr, nativeToScVal, Address } = await import("@stellar/stellar-sdk");
  const active = Keypair.random(),
    pending = Keypair.random();
  const key = (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);
  const storage = [
    new xdr.ScMapEntry({
      key: key("PendingAdmin"),
      val: new Address(pending.publicKey()).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: key("InstanceState"),
      val: nativeToScVal({
        admin: new Address(active.publicKey()).toScVal(),
        result_count: 0n,
      }),
    }),
  ];
  const getContractData = vi.fn(async () => ({
    val: {
      contractData: () => ({
        val: () => ({ instance: () => ({ storage: () => storage }) }),
      }),
    },
  }));
  expect(
    await readOracleAdmin({ getContractData } as any, "oracle-contract"),
  ).toBe(active.publicKey());
  storage.pop();
  await expect(
    readOracleAdmin({ getContractData } as any, "oracle-contract"),
  ).rejects.toThrow("not initialized");
});
