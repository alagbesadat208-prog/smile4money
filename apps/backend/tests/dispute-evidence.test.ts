import { describe, it, expect } from "vitest";
import {
  assertNoSecrets,
  buildEvidenceBundle,
  EvidenceError,
  type EvidenceDeps,
} from "../src/services/dispute-evidence.js";
import type { MatchRecord } from "../src/store/match-store.js";
import type { DlqEntry } from "../src/store/persistent-queue-store.js";

/** Dispute evidence bundle: contents, privacy and refusal to leak secrets (issue #116). */

// Shaped like real values but fake. Joined at runtime so the repo's
// secret scan doesn't flag the fixture.
const STELLAR_SEED =
  "S" + "CZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4";
const JWT = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiJmaXh0dXJlIn0",
  "c2lnbmF0dXJlLXNpZw",
].join(".");

const MATCH: MatchRecord = {
  matchId: 7,
  player1: "GAPLAYERONEADDRESS",
  player2: "GAPLAYERTWOADDRESS",
  player1Username: "fixture-white",
  player2Username: "fixture-black",
  stakeAmount: 1_000_000,
  token: "CTOKENCONTRACT",
  gameId: "fxGame07",
  platform: "lichess",
  state: "Pending",
  identityHash: "a".repeat(64),
};

const entry = (
  id: string,
  payload: unknown,
  extra: Partial<DlqEntry> = {},
): DlqEntry => ({
  id,
  payload,
  failureReason: "RPC sendTransaction failed: Network error",
  attempts: 3,
  createdAt: Date.UTC(2026, 0, 1),
  lastAttemptAt: Date.UTC(2026, 0, 2),
  ...extra,
});

function deps(overrides: Partial<EvidenceDeps> = {}): EvidenceDeps {
  return {
    findMatch: async (gameId) => (gameId === MATCH.gameId ? MATCH : null),
    listDlqEntries: async () => [
      entry("d1", { matchId: 7, gameId: "fxGame07", result: "Player1Wins" }),
      entry(
        "d2",
        { job: { matchId: 7, gameId: "fxGame07" } },
        { failureReason: "max polling attempts exceeded" },
      ),
      entry("other", { matchId: 8, gameId: "fxGame08", result: "Draw" }),
    ],
    fetchProviderResult: async () => ({
      gameId: "fxGame07",
      status: "mate",
      whitePlayer: "fixture-white",
      blackPlayer: "fixture-black",
      result: "Player1Wins",
    }),
    resultOnChain: async () => false,
    network: "testnet",
    escrowContractId: "CESCROWCONTRACT",
    oracleContractId: "CORACLECONTRACT",
    now: () => new Date("2026-02-01T00:00:00Z"),
    ...overrides,
  };
}

describe("buildEvidenceBundle", () => {
  it("collects match, provider, oracle and ledger references for one match", async () => {
    const b = await buildEvidenceBundle("fxGame07", deps(), 7);

    expect(b.match).toMatchObject({
      matchId: 7,
      gameId: "fxGame07",
      platform: "lichess",
      player1: "GAPLAYERONEADDRESS",
    });
    expect(b.match.identityHash).toBe("a".repeat(64));
    expect(b.provider.gameUrl).toBe("https://lichess.org/fxGame07");
    expect(b.provider.lookup).toEqual({
      status: "ok",
      gameStatus: "mate",
      result: "Player1Wins",
      playersMatchRecord: true,
    });
    expect(b.oracle.dlqEntries.map((e) => e.id)).toEqual(["d1", "d2"]);
    expect(b.oracle.dlqEntries[0]).toMatchObject({
      attempts: 3,
      payloadResult: "Player1Wins",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(b.ledger).toMatchObject({
      network: "testnet",
      resultRecordedOnChain: false,
    });
    expect(b.ledger.explorerUrls).toEqual([
      "https://stellar.expert/explorer/testnet/contract/CESCROWCONTRACT",
      "https://stellar.expert/explorer/testnet/contract/CORACLECONTRACT",
    ]);
    expect(b.generatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("leaves out chess usernames and anything not on the allow-list", async () => {
    const leaky = {
      ...MATCH,
      player1Username: "real-handle-1",
      player2Username: "real-handle-2",
      email: "a@b.c",
      ip: "10.0.0.1",
    };
    const b = await buildEvidenceBundle(
      "fxGame07",
      deps({ findMatch: async () => leaky as MatchRecord }),
    );
    const text = JSON.stringify(b);
    for (const v of ["real-handle-1", "real-handle-2", "a@b.c", "10.0.0.1"])
      expect(text).not.toContain(v);
  });

  it("reports whether the provider players still match the record, without naming them", async () => {
    const b = await buildEvidenceBundle(
      "fxGame07",
      deps({
        fetchProviderResult: async () => ({
          gameId: "fxGame07",
          status: "mate",
          whitePlayer: "someone-else",
          blackPlayer: "fixture-black",
          result: "Player1Wins",
        }),
      }),
    );
    expect(b.provider.lookup).toMatchObject({ playersMatchRecord: false });
    expect(JSON.stringify(b)).not.toContain("someone-else");
  });

  it("records a provider failure instead of failing the export, and supports offline mode", async () => {
    const failed = await buildEvidenceBundle(
      "fxGame07",
      deps({
        fetchProviderResult: async () => {
          throw new Error("ECONNRESET");
        },
      }),
    );
    expect(failed.provider.lookup).toEqual({
      status: "error",
      error: "ECONNRESET",
    });

    const offline = await buildEvidenceBundle(
      "fxGame07",
      deps({ fetchProviderResult: undefined, resultOnChain: undefined }),
    );
    expect(offline.provider.lookup).toEqual({ status: "skipped" });
    expect(offline.ledger.resultRecordedOnChain).toBe("unknown");
  });

  it('an on-chain lookup failure is "unknown", not false', async () => {
    const b = await buildEvidenceBundle(
      "fxGame07",
      deps({
        resultOnChain: async () => {
          throw new Error("RPC down");
        },
      }),
    );
    expect(b.ledger.resultRecordedOnChain).toBe("unknown");
  });

  it("carries the DLQ trace id when an entry has one", async () => {
    const traced = entry("t1", {
      matchId: 7,
      gameId: "fxGame07",
      result: "Draw",
    }) as DlqEntry & { traceContext: unknown };
    traced.traceContext = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    };
    const b = await buildEvidenceBundle(
      "fxGame07",
      deps({ listDlqEntries: async () => [traced] }),
    );
    expect(b.oracle.dlqEntries[0].traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
  });

  it("rejects an unknown game and a matchId that disagrees with the record", async () => {
    await expect(buildEvidenceBundle("nope", deps())).rejects.toBeInstanceOf(
      EvidenceError,
    );
    await expect(buildEvidenceBundle("fxGame07", deps(), 8)).rejects.toThrow(
      /belongs to match 7, not 8/,
    );
  });

  it("has a stable digest over the body", async () => {
    const a = await buildEvidenceBundle("fxGame07", deps());
    const b = await buildEvidenceBundle("fxGame07", deps());
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.digest).toBe(b.digest);
  });

  it("refuses to export when a secret reached the bundle through a failure reason", async () => {
    const leaking = entry(
      "leak",
      { matchId: 7, gameId: "fxGame07", result: "Draw" },
      {
        failureReason: `tx signing failed with key ${STELLAR_SEED}`,
      },
    );
    await expect(
      buildEvidenceBundle(
        "fxGame07",
        deps({ listDlqEntries: async () => [leaking] }),
      ),
    ).rejects.toThrow(/Stellar secret seed/);
  });
});

describe("assertNoSecrets", () => {
  it.each([
    ["a Stellar secret seed", { k: STELLAR_SEED }],
    ["a JWT", { k: `Bearer ${JWT}` }],
    ["a Lichess token", { k: "lip_FixtureToken1234567890" }],
    ["a PEM key", { k: ["-----BEGIN", "PRIVATE KEY-----"].join(" ") }],
  ])("rejects %s", (_label, value) => {
    expect(() => assertNoSecrets(value, {})).toThrow(EvidenceError);
  });

  it("rejects the value of a configured secret env var", () => {
    expect(() =>
      assertNoSecrets(
        { note: "x my-jwt-secret-value y" },
        { JWT_SECRET: "my-jwt-secret-value" },
      ),
    ).toThrow(/JWT_SECRET/);
  });

  it("accepts public identifiers and placeholders", () => {
    expect(() =>
      assertNoSecrets(
        {
          address: "GAPLAYERONEADDRESS",
          contract: "CESCROWCONTRACT",
          hash: "a".repeat(64),
        },
        { JWT_SECRET: "short" },
      ),
    ).not.toThrow();
  });
});
