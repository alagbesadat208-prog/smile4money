/**
 * Operator CLI: export the dispute evidence bundle for one match (issue #116).
 *
 *   npm run evidence -- --game-id <gameId> [--match-id <n>] [--offline]
 *
 * Runs on the backend host (or a shell with the same env and data volume): it
 * reads the match store and DLQ directly, so there is no HTTP endpoint and no
 * way for a player's wallet token to pull someone else's evidence. Writes the
 * bundle as JSON on stdout; procedure and field meanings are in
 * docs/runbook.md §3.4. `--offline` skips the provider re-fetch.
 */
import dotenv from "dotenv";
dotenv.config();

// stdout carries only the bundle, so it can be piped to a file or `jq`. The
// stores and logger write their JSON log lines with console.log; send those
// to stderr instead.
console.log = (...args: unknown[]) => console.error(...args);

import { matchStore, initializeMatchStore } from "../store/index.js";
import { closeQueue, initializeQueue, listDlqEntries } from "../queue.js";
import { fetchLichessResult } from "../fetchers/lichess.js";
import { fetchChessDotComResult } from "../fetchers/chessdotcom.js";
import {
  buildEvidenceBundle,
  EvidenceError,
} from "../services/dispute-evidence.js";
import type { MatchRecord } from "../store/match-store.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function fetchProviderResult(match: MatchRecord) {
  if (match.platform === "lichess") return fetchLichessResult(match.gameId);
  if (match.platform === "chessdotcom") {
    if (!match.player1Username)
      throw new Error(
        "match has no recorded Chess.com username to search archives with",
      );
    return fetchChessDotComResult(match.player1Username, match.gameId);
  }
  throw new Error(`unknown platform ${match.platform}`);
}

async function main(): Promise<number> {
  const gameId = arg("game-id");
  const rawMatchId = arg("match-id");
  if (!gameId) {
    process.stderr.write(
      "usage: npm run evidence -- --game-id <gameId> [--match-id <n>] [--offline]\n",
    );
    return 2;
  }
  const matchId = rawMatchId === undefined ? undefined : Number(rawMatchId);
  if (matchId !== undefined && !Number.isInteger(matchId)) {
    process.stderr.write(`--match-id must be an integer, got ${rawMatchId}\n`);
    return 2;
  }

  await initializeMatchStore();
  await initializeQueue();
  try {
    const bundle = await buildEvidenceBundle(
      gameId,
      {
        findMatch: (id) =>
          matchStore.findByGameId(id) as Promise<MatchRecord | null>,
        listDlqEntries,
        fetchProviderResult: process.argv.includes("--offline")
          ? undefined
          : fetchProviderResult,
        network: process.env.STELLAR_NETWORK ?? "testnet",
        escrowContractId: process.env.CONTRACT_ESCROW,
        oracleContractId: process.env.CONTRACT_ORACLE,
      },
      matchId,
    );
    process.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(
      `${err instanceof EvidenceError ? "evidence" : "error"}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  } finally {
    await closeQueue();
  }
}

main().then((code) => process.exit(code));
