import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  persistEvidence,
  loadEvidence,
  type SettlementEvidence,
} from "../src/services/settlement-evidence.js";
import { replaySettlement } from "../src/commands/replay-settlement.js";
import { verifyGameResult } from "../src/services/oracle-service.js";
import { MatchStore } from "../src/store/match-store.js";
import { fetchLichessResult } from "../src/fetchers/lichess.js";
vi.mock("../src/fetchers/lichess.js", async () => ({
  ...(await vi.importActual<object>("../src/fetchers/lichess.js")),
  fetchLichessResult: vi.fn(),
}));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "replay-"));
  vi.stubEnv("SETTLEMENT_EVIDENCE_DIR", directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const store = new MatchStore();
  const match = await store.createMatch({
    player1: "alice-address",
    player2: "bob-address",
    player1Username: "alice",
    player2Username: "bob",
    stakeAmount: 1,
    token: "xlm",
    gameId: "game",
    platform: "lichess",
  });
  const input = {
    matchId: match.matchId,
    gameId: match.gameId,
    platform: match.platform,
  };
  const game = {
    gameId: "game",
    whitePlayer: "alice",
    blackPlayer: "intruder",
    result: "Player1Wins" as const,
    status: "mate",
  };
  return {
    store,
    evidence: { version: 1, match, input, game } as SettlementEvidence,
  };
}
describe("restricted settlement replay", () => {
  it("reproduces a live failed decision after the upstream response changes", async () => {
    const { store, evidence } = await fixture();
    vi.mocked(fetchLichessResult).mockResolvedValue(evidence.game);
    const original = await verifyGameResult(store, evidence.input);
    expect(original.ok).toBe(false);
    const id = await persistEvidence(evidence);
    vi.mocked(fetchLichessResult).mockRejectedValue(
      new Error("upstream unavailable"),
    );
    vi.mocked(fetchLichessResult).mockClear();
    const first = await replaySettlement(["--dry-run", id], "true");
    const second = await replaySettlement(["--dry-run", id], "true");
    expect(first.decision).toEqual(original);
    expect(second).toEqual(first);
    expect(fetchLichessResult).not.toHaveBeenCalled();
  });
  it("requires operator opt-in and cannot submit or accept arbitrary paths", async () => {
    await expect(
      replaySettlement(["--dry-run", "anything"], "false"),
    ).rejects.toThrow("disabled");
    await expect(
      replaySettlement(["--submit", "anything"], "true"),
    ).rejects.toThrow("prohibited");
    await expect(loadEvidence("../../secret")).rejects.toThrow(
      "Invalid evidence ID",
    );
  });
  it("detects evidence tampering and preserves immutable snapshots", async () => {
    const { evidence } = await fixture();
    const id = await persistEvidence(evidence);
    expect(await loadEvidence(id)).toEqual(evidence);
    await writeFile(path.join(directory, `${id}.json`), "{}");
    await expect(loadEvidence(id)).rejects.toThrow("checksum");
  });
});
