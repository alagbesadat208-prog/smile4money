/**
 * Dispute evidence bundle (issue #116).
 *
 * Gathers, for one match, every reference support needs to investigate a
 * disputed settlement: the match record, what the chess provider reports now,
 * what the oracle did (DLQ history), and where to look on-chain. See
 * docs/runbook.md §3.4 for the retrieval procedure.
 *
 * Privacy by construction: the bundle is built from an explicit allow-list of
 * fields, never by copying records wholesale, so new fields on a match or DLQ
 * entry don't leak into it. It deliberately leaves out:
 *   - chess usernames. Support compares players through `identityHash` and
 *     the provider's verdict on whether the players match, not raw handles;
 *   - request bodies, JWTs, IPs and anything else about who asked;
 *   - every signing secret and credential. `assertNoSecrets` re-scans the
 *     finished bundle and refuses to return it if anything secret-shaped
 *     (a Stellar secret seed, a JWT, a provider token, or the value of a
 *     configured secret env var) appears anywhere in it.
 *
 * Wallet addresses are included: they are public on-chain identifiers and the
 * only way to line the bundle up with ledger entries.
 */
import { createHash } from "node:crypto";
import type { MatchRecord } from "../store/match-store.js";
import type { DlqEntry } from "../store/persistent-queue-store.js";
import type { GameResult } from "../fetchers/lichess.js";

export const EVIDENCE_BUNDLE_VERSION = 1;

export interface EvidenceDeps {
  findMatch(gameId: string): Promise<MatchRecord | null>;
  listDlqEntries(): Promise<DlqEntry[]>;
  /** Re-fetch the provider result. Optional: support may run offline. */
  fetchProviderResult?(match: MatchRecord): Promise<GameResult>;
  /** Ask the oracle contract whether a result is recorded. Optional. */
  resultOnChain?(matchId: number): Promise<boolean>;
  network: string;
  escrowContractId?: string;
  oracleContractId?: string;
  now?: () => Date;
}

export interface EvidenceBundle {
  bundleVersion: number;
  generatedAt: string;
  /** SHA-256 of the bundle body, so a copy pasted into a ticket can be checked. */
  digest: string;
  match: {
    matchId: number;
    gameId: string;
    platform: string;
    state: string;
    stakeAmount: number;
    token: string;
    player1: string;
    player2: string;
    identityHash: string | null;
  };
  provider: {
    gameUrl: string | null;
    lookup:
      | {
          status: "ok";
          gameStatus: string;
          result: string | null;
          playersMatchRecord: boolean | null;
        }
      | { status: "error"; error: string }
      | { status: "skipped" };
  };
  oracle: {
    dlqEntries: Array<{
      id: string;
      failureReason: string;
      attempts: number;
      createdAt: string;
      lastAttemptAt: string | null;
      traceparent: string | null;
      payloadResult: string | null;
    }>;
  };
  ledger: {
    network: string;
    escrowContractId: string | null;
    oracleContractId: string | null;
    resultRecordedOnChain: boolean | "unknown";
    explorerUrls: string[];
  };
}

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["Stellar secret seed", /\bS[A-Z2-7]{55}\b/],
  ["JWT", /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/],
  ["Lichess token", /\bli[op]_[A-Za-z0-9]{8,}/],
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Env vars whose values must never appear in a bundle. */
export const SECRET_ENV_VARS = [
  "ORACLE_SECRET_KEY",
  "ORACLE_SIGNING_KEY",
  "ADMIN_SECRET_KEY",
  "DEPLOYER_SECRET_KEY",
  "MAINNET_DEPLOYER_SECRET_KEY",
  "JWT_SECRET",
  "LICHESS_API_TOKEN",
  "CHESSDOTCOM_API_KEY",
] as const;

/** Throws when anything secret-shaped appears anywhere in `value`. */
export function assertNoSecrets(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const text = JSON.stringify(value);
  for (const [label, re] of SECRET_PATTERNS) {
    if (re.test(text))
      throw new EvidenceError(
        `evidence bundle contains a ${label}; refusing to export it`,
      );
  }
  for (const name of SECRET_ENV_VARS) {
    const secret = env[name];
    if (secret && secret.length >= 8 && text.includes(secret)) {
      throw new EvidenceError(
        `evidence bundle contains the value of ${name}; refusing to export it`,
      );
    }
  }
}

function providerGameUrl(match: MatchRecord): string | null {
  if (match.platform === "lichess")
    return `https://lichess.org/${encodeURIComponent(match.gameId)}`;
  if (match.platform === "chessdotcom")
    return `https://www.chess.com/game/live/${encodeURIComponent(match.gameId)}`;
  return null;
}

function explorerUrls(
  network: string,
  ids: Array<string | undefined>,
): string[] {
  const net =
    network.toLowerCase() === "mainnet" || network.toLowerCase() === "public"
      ? "public"
      : "testnet";
  return ids
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map(
      (id) =>
        `https://stellar.expert/explorer/${net}/contract/${encodeURIComponent(id)}`,
    );
}

function payloadMatchId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { matchId?: unknown; job?: { matchId?: unknown } };
  if (typeof p.matchId === "number") return p.matchId;
  if (p.job && typeof p.job.matchId === "number") return p.job.matchId;
  return null;
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : null;
}

function digestOf(body: Omit<EvidenceBundle, "digest">): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * Build the evidence bundle for the match behind `gameId`. When `matchId` is
 * given it must agree with the stored record, so a ticket's two references
 * can't silently point at different matches.
 */
export async function buildEvidenceBundle(
  gameId: string,
  deps: EvidenceDeps,
  matchId?: number,
): Promise<EvidenceBundle> {
  const match = await deps.findMatch(gameId);
  if (!match) throw new EvidenceError(`no match recorded for gameId ${gameId}`);
  if (matchId !== undefined && match.matchId !== matchId) {
    throw new EvidenceError(
      `gameId ${gameId} belongs to match ${match.matchId}, not ${matchId}`,
    );
  }

  let lookup: EvidenceBundle["provider"]["lookup"] = { status: "skipped" };
  if (deps.fetchProviderResult) {
    try {
      const r = await deps.fetchProviderResult(match);
      const recorded =
        match.player1Username && match.player2Username
          ? r.whitePlayer.toLowerCase() ===
              match.player1Username.toLowerCase() &&
            r.blackPlayer.toLowerCase() === match.player2Username.toLowerCase()
          : null;
      lookup = {
        status: "ok",
        gameStatus: r.status,
        result: r.result,
        playersMatchRecord: recorded,
      };
    } catch (err) {
      lookup = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const dlqEntries = (await deps.listDlqEntries())
    .filter((e) => payloadMatchId(e.payload) === match.matchId)
    .map((e) => {
      const trace = (
        e as DlqEntry & { traceContext?: { traceparent?: unknown } }
      ).traceContext;
      const payloadResult = (e.payload as { result?: unknown })?.result;
      return {
        id: e.id,
        failureReason: e.failureReason,
        attempts: e.attempts,
        createdAt: iso(e.createdAt) ?? "",
        lastAttemptAt: iso(e.lastAttemptAt),
        traceparent:
          typeof trace?.traceparent === "string" ? trace.traceparent : null,
        payloadResult: typeof payloadResult === "string" ? payloadResult : null,
      };
    });

  let resultRecordedOnChain: boolean | "unknown" = "unknown";
  if (deps.resultOnChain) {
    try {
      resultRecordedOnChain = await deps.resultOnChain(match.matchId);
    } catch {
      resultRecordedOnChain = "unknown";
    }
  }

  const body: Omit<EvidenceBundle, "digest"> = {
    bundleVersion: EVIDENCE_BUNDLE_VERSION,
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    match: {
      matchId: match.matchId,
      gameId: match.gameId,
      platform: match.platform,
      state: match.state,
      stakeAmount: match.stakeAmount,
      token: match.token,
      player1: match.player1,
      player2: match.player2,
      identityHash: match.identityHash ?? null,
    },
    provider: { gameUrl: providerGameUrl(match), lookup },
    oracle: { dlqEntries },
    ledger: {
      network: deps.network,
      escrowContractId: deps.escrowContractId ?? null,
      oracleContractId: deps.oracleContractId ?? null,
      resultRecordedOnChain,
      explorerUrls: explorerUrls(deps.network, [
        deps.escrowContractId,
        deps.oracleContractId,
      ]),
    },
  };

  const bundle: EvidenceBundle = { ...body, digest: digestOf(body) };
  assertNoSecrets(bundle);
  return bundle;
}
