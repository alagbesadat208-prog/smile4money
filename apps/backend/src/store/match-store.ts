import { computeIdentityHash } from '../services/player-identity.js';

export interface MatchRecord {
  matchId: number;
  player1: string;
  player2: string;
  player1Username?: string; // Chess platform username for player1 (optional for backward compatibility)
  player2Username?: string; // Chess platform username for player2 (optional for backward compatibility)
  stakeAmount: number;
  token: string;
  gameId: string;
  platform: string;
  state: 'Pending';
  /**
   * SHA-256 binding of (player1Username, player1, player2Username, player2),
   * computed once at creation (#1720). Verified against a fresh recomputation
   * before the oracle accepts a result — see
   * `services/player-identity.ts#verifyIdentityHash`. Undefined when the
   * match was created without both usernames captured (nothing to bind yet).
   */
  identityHash?: string;
  evidence?: CanonicalSettlementEvidence;
}

export interface CanonicalSettlementEvidence {
  parserVersion: string;
  evaluatedAt: string;
  matchId: number;
  gameId: string;
  platform: string;
  whitePlayer: string;
  blackPlayer: string;
  result: string | null;
  status: string;
  decision: 'verified' | 'player_identity_mismatch' | 'identity_hash_mismatch';
}

export interface CreateMatchPayload {
  player1: string;
  player2: string;
  player1Username?: string;
  player2Username?: string;
  stakeAmount: number;
  token: string;
  gameId: string;
  platform: string;
}

export interface MatchStorePort {
  createMatch(payload: CreateMatchPayload): Promise<MatchRecord>;
  findByGameId(gameId: string): Promise<MatchRecord | null>;
  count(): Promise<number>;
  saveSettlementEvidence(evidence: CanonicalSettlementEvidence): Promise<void>;
  getSettlementEvidence(matchId: number): Promise<CanonicalSettlementEvidence | null>;
  getSettlementEvidenceHistory(matchId: number): Promise<CanonicalSettlementEvidence[]>;
}

export class MatchStore {
  private matches = new Map<number, MatchRecord>();
  private gameIds = new Set<string>();
  private nextId = 0;
  private evidenceByMatch = new Map<number, CanonicalSettlementEvidence[]>();

  async saveSettlementEvidence(evidence: CanonicalSettlementEvidence): Promise<void> {
    const records = this.evidenceByMatch.get(evidence.matchId) ?? [];
    records.push({ ...evidence });
    this.evidenceByMatch.set(evidence.matchId, records);
  }

  async getSettlementEvidence(matchId: number): Promise<CanonicalSettlementEvidence | null> {
    const records = this.evidenceByMatch.get(matchId);
    const evidence = records?.[records.length - 1];
    return evidence ? { ...evidence } : null;
  }

  async getSettlementEvidenceHistory(matchId: number): Promise<CanonicalSettlementEvidence[]> {
    return (this.evidenceByMatch.get(matchId) ?? []).map((record) => ({ ...record }));
  }

  async createMatch(payload: CreateMatchPayload): Promise<MatchRecord> {
    if (this.gameIds.has(payload.gameId)) {
      throw new Error('duplicate game_id');
    }

    // #1720 — bind the identity captured at creation to the match record via
    // a hash, so a later divergence between the stored usernames/addresses
    // and what they were at creation time is detectable rather than silently
    // trusted. Only computable when both usernames were captured.
    const identityHash =
      payload.player1Username && payload.player2Username
        ? computeIdentityHash(
            payload.player1Username,
            payload.player1,
            payload.player2Username,
            payload.player2,
          )
        : undefined;

    const record: MatchRecord = {
      matchId: this.nextId,
      player1: payload.player1,
      player2: payload.player2,
      player1Username: payload.player1Username,
      player2Username: payload.player2Username,
      stakeAmount: payload.stakeAmount,
      token: payload.token,
      gameId: payload.gameId,
      platform: payload.platform,
      state: 'Pending',
      identityHash,
    };

    this.matches.set(this.nextId, record);
    this.gameIds.add(payload.gameId);
    this.nextId += 1;
    return record;
  }

  async findByGameId(gameId: string): Promise<MatchRecord | null> {
    for (const match of this.matches.values()) {
      if (match.gameId === gameId) {
        return match;
      }
    }
    return null;
  }

  async count(): Promise<number> {
    return this.matches.size;
  }

  clear(): void {
    this.matches.clear();
    this.gameIds.clear();
    this.nextId = 0;
    this.evidenceByMatch.clear();
  }
}
