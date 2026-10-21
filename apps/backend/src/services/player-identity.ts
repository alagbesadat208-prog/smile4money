/**
 * Player Identity Verification Service
 *
 * This service verifies that the players reported by the chess platform APIs
 * (Lichess or Chess.com) correspond to the Stellar addresses registered in
 * the on-chain match record.
 *
 * Security Model:
 * ───────────────
 * When a match is created, the off-chain oracle records the mapping between:
 *   - Stellar addresses (player1, player2)
 *   - Chess platform usernames (e.g., alice, bob on Lichess)
 *
 * When the oracle later fetches and submits a game result, it verifies:
 *   1. The game exists on the platform
 *   2. The two players in the game match the registered mapping
 *   3. The result is submitted to the correct match_id
 *
 * This prevents a malicious actor from "swapping" results between matches or
 * injecting game results where the oracle never verified player identities.
 *
 * Example Attack Scenario (Without Verification):
 * ───────────────────────────────────────────────
 * 1. Admin creates match: (player1=Alice, player2=Bob) for game ABC123
 * 2. Malicious oracle submits result of DIFFERENT game XYZ789 where:
 *    - White: Charlie, Black: David
 *    - Result: Charlie wins
 * 3. Escrow contract pays Alice (player1) because the result says "Player1Wins"
 * 4. But Charlie and David played game XYZ789, not Alice and Bob!
 *
 * Defense:
 * ─────────
 * Before accepting the result, the oracle verifies:
 *   - Game ABC123 players: white=alice, black=bob ✓ matches player1/player2
 *   - Result: alice wins → payout to Alice (player1) ✓ correct
 *
 * Injected game XYZ789 would be rejected because charlie/david don't match
 * the registered players.
 */

import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import axios from 'axios';
import type { GameResult } from '../fetchers/lichess.js';
import type { MatchRecord } from '../store/match-store.js';

const LINK_NONCE_TTL_MS = 5 * 60 * 1000;
const pendingLinks = new Map<string, { address: string; platform: string; username: string; expiresAt: number }>();
const verifiedLinks = new Map<string, { address: string; platform: string; username: string; linkedAt: string }>();
const MAX_PENDING_LINKS = 4096;

export interface IdentityLinkChallenge { nonce: string; message: string; profileProof: string; expiresAt: string }

export function createIdentityLinkChallenge(address: string, platform: string, username: string): IdentityLinkChallenge {
  if (!/^G[A-Z2-7]{55}$/.test(address) || !['lichess', 'chessdotcom'].includes(platform) || !username.trim()) {
    throw new Error('A valid Stellar address, platform, and username are required');
  }
  for (const [key, pending] of pendingLinks) {
    if (pending.expiresAt <= Date.now()) pendingLinks.delete(key);
  }
  if (pendingLinks.size >= MAX_PENDING_LINKS) {
    const oldestNonce = pendingLinks.keys().next().value;
    if (oldestNonce) pendingLinks.delete(oldestNonce);
  }
  const nonce = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + LINK_NONCE_TTL_MS;
  pendingLinks.set(nonce, { address, platform, username: username.trim(), expiresAt });
  const message = `smile4money identity link\nwallet:${address}\nplatform:${platform}\nusername:${username.trim()}\nnonce:${nonce}`;
  return {
    nonce,
    message,
    profileProof: `smile4money:${nonce}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

async function verifyChessProfile(platform: string, username: string, profileProof: string): Promise<boolean> {
  const url = platform === 'lichess'
    ? `https://lichess.org/api/user/${encodeURIComponent(username)}`
    : `https://api.chess.com/pub/player/${encodeURIComponent(username)}`;
  const response = await axios.get(url, { timeout: 10_000, headers: { Accept: 'application/json' } });
  const account = response.data as { username?: string; id?: string; profile?: { bio?: string }; location?: string };
  const returnedUsername = account.username ?? account.id;
  if (!returnedUsername || returnedUsername.toLowerCase() !== username.toLowerCase()) return false;
  const profileText = platform === 'lichess' ? account.profile?.bio : account.location;
  return typeof profileText === 'string' && profileText.includes(profileProof);
}

export async function confirmIdentityLink(
  nonce: string,
  address: string,
  signatureHex: string,
  verifyProfile: typeof verifyChessProfile = verifyChessProfile,
): Promise<boolean> {
  const pending = pendingLinks.get(nonce);
  if (!pending || pending.expiresAt <= Date.now() || pending.address !== address || !/^[0-9a-f]{128}$/i.test(signatureHex)) {
    if (pending && pending.expiresAt <= Date.now()) pendingLinks.delete(nonce);
    return false;
  }
  const message = `smile4money identity link\nwallet:${pending.address}\nplatform:${pending.platform}\nusername:${pending.username}\nnonce:${nonce}`;
  const digest = createHash('sha256').update(message).digest();
  let valid = false;
  try { valid = Keypair.fromPublicKey(address).verify(digest, Buffer.from(signatureHex, 'hex')); } catch { valid = false; }
  if (!valid) return false;
  let profileVerified = false;
  try { profileVerified = await verifyProfile(pending.platform, pending.username, `smile4money:${nonce}`); } catch { return false; }
  if (!profileVerified) return false;
  pendingLinks.delete(nonce);
  verifiedLinks.set(`${pending.platform}:${pending.username.toLowerCase()}`, { address, platform: pending.platform, username: pending.username, linkedAt: new Date().toISOString() });
  return true;
}

export function getLinkedWallet(platform: string, username: string): string | null {
  return verifiedLinks.get(`${platform}:${username.trim().toLowerCase()}`)?.address ?? null;
}

/**
 * Represents the mapping of Stellar addresses to chess platform usernames.
 */
export interface PlayerIdentityMap {
  /** Player 1's Stellar address */
  player1Address: string;
  /** Player 1's username on the chess platform */
  player1Username: string;
  /** Player 2's Stellar address */
  player2Address: string;
  /** Player 2's username on the chess platform */
  player2Username: string;
  /** Chess platform ('lichess' or 'chessdotcom') */
  platform: string;
}

/**
 * Result of player identity verification.
 */
export interface VerificationResult {
  valid: boolean;
  error?: string;
}

/**
 * Verify that the players in an API game result match the on-chain match record.
 *
 * # Arguments
 *
 * - `match` - The on-chain match record with registered player addresses
 * - `result` - The game result from the chess platform API
 *
 * # Returns
 *
 * - `{ valid: true }` if players match
 * - `{ valid: false, error: "..." }` if verification fails
 *
 * # Verification Logic
 *
 * The function checks if the reported players (by username) correspond to the
 * registered Stellar addresses:
 *
 * 1. **Exact Match**: Both usernames match in order
 *    - API: white=alice, black=bob
 *    - Registered: player1=alice, player2=bob
 *    - Result: ✓ Valid
 *
 * 2. **Swapped Players**: Usernames match but in reverse order
 *    - API: white=bob, black=alice
 *    - Registered: player1=alice, player2=bob
 *    - Result: ✓ Valid (but result will be flipped: player2 wins instead of player1)
 *
 * 3. **Missing Player**: Username not found or doesn't match
 *    - API: white=alice, black=charlie
 *    - Registered: player1=alice, player2=bob
 *    - Result: ✗ Invalid (charlie ≠ bob)
 *
 * 4. **Injected Game**: Completely different players
 *    - API: white=charlie, black=david
 *    - Registered: player1=alice, player2=bob
 *    - Result: ✗ Invalid (charlie ≠ alice, david ≠ bob)
 *
 * # Case Sensitivity
 *
 * Usernames are compared case-insensitively after trimming whitespace,
 * as chess platform usernames are typically case-insensitive.
 */
export function verifyPlayerIdentities(
  match: MatchRecord,
  result: GameResult,
  identityMap: PlayerIdentityMap,
): VerificationResult {
  // Normalize usernames for comparison (case-insensitive, trim whitespace)
  const normalize = (name: string) => (name || '').trim().toLowerCase();

  const whiteNorm = normalize(result.whitePlayer);
  const blackNorm = normalize(result.blackPlayer);
  const player1Norm = normalize(identityMap.player1Username);
  const player2Norm = normalize(identityMap.player2Username);

  // An empty username must never be considered a valid player identity.
  // If either the API-reported name or the registered name is empty, the
  // normalization above would collapse it to "" and could otherwise produce a
  // false-positive match (e.g. an empty registered name matching an empty API
  // name). Reject any pairing that contains an empty username.
  if (!whiteNorm || !blackNorm || !player1Norm || !player2Norm) {
    return {
      valid: false,
      error: `Player identity contains an empty username. Expected (${player1Norm || '<empty>'}, ${player2Norm || '<empty>'}) but got (${whiteNorm || '<empty>'}, ${blackNorm || '<empty>'})`,
    };
  }

  // Check for exact match: white=player1, black=player2
  if (whiteNorm === player1Norm && blackNorm === player2Norm) {
    return { valid: true };
  }

  // Check for swapped match: white=player2, black=player1
  // This is valid because the players can play on either color.
  // The result will be interpreted differently (player2 wins → player1 wins),
  // but the game involves the correct players.
  if (whiteNorm === player2Norm && blackNorm === player1Norm) {
    return { valid: true };
  }

  // If neither exact nor swapped matches, the players don't correspond
  return {
    valid: false,
    error: `Player identity mismatch. Expected (${player1Norm}, ${player2Norm}) or (${player2Norm}, ${player1Norm}), but got (${whiteNorm}, ${blackNorm})`,
  };
}

/**
 * Identity Hash Binding (#1720)
 * ─────────────────────────────
 *
 * `verifyPlayerIdentities` above checks usernames reported by the chess
 * platform API against the usernames captured in the match record — but
 * that captured record itself was never cryptographically bound to the
 * match. Nothing stopped the stored `player1Username`/`player2Username`
 * fields from being altered after creation (a storage bug, a future code
 * path, direct DB access) and `verifyPlayerIdentities` would happily verify
 * against the *new* value, having no way to tell it had changed.
 *
 * `computeIdentityHash` produces a single SHA-256 digest over all four
 * identity-defining fields (both players' platform usernames and Stellar
 * addresses) at match-creation time. `MatchStore`/`SqliteMatchStore` persist
 * it alongside the record as `identityHash`. Before accepting a result,
 * `verifyIdentityHash` recomputes the digest from the match record's
 * *current* fields and compares it to the stored one — any divergence means
 * the identity binding captured at creation no longer matches what is on
 * record, and the result is rejected rather than silently verified against
 * whatever the fields now say.
 *
 * Hashing (rather than storing the fields a second time) means the stored
 * fields and the hash can be compared without a separate "trusted copy" to
 * keep in sync, and the digest is cheap to carry in signed match metadata or
 * on-chain if the binding later needs to move there.
 */

/**
 * Compute the identity-binding hash for a match: SHA-256 of both players'
 * platform usernames and Stellar addresses, normalized the same way
 * `verifyPlayerIdentities` normalizes usernames (trimmed, lowercased) so the
 * hash is stable regardless of incidental casing/whitespace differences
 * between the value captured at creation and any later re-read of it.
 * Stellar addresses are uppercased (their canonical StrKey form) rather than
 * lowercased, so a hash computed here always matches one computed from a
 * canonically-formatted address regardless of input casing.
 */
export function computeIdentityHash(
  player1Username: string,
  player1Address: string,
  player2Username: string,
  player2Address: string,
): string {
  const normalizeUsername = (name: string) => (name || '').trim().toLowerCase();
  const normalizeAddress = (address: string) => (address || '').trim().toUpperCase();

  const material = [
    normalizeUsername(player1Username),
    normalizeAddress(player1Address),
    normalizeUsername(player2Username),
    normalizeAddress(player2Address),
  ].join(':');

  return createHash('sha256').update(material).digest('hex');
}

/**
 * Verify that `match`'s stored `identityHash` (set at creation time) still
 * matches a hash freshly recomputed from the match's current identity
 * fields. Returns `{ valid: true }` when they match, or when the match
 * predates this feature and has no stored hash (backward compatibility —
 * such matches fall back to `verifyPlayerIdentities` alone, same as before
 * this existed).
 */
export function verifyIdentityHash(match: MatchRecord): VerificationResult {
  if (!match.identityHash) {
    return { valid: true };
  }
  if (!match.player1Username || !match.player2Username) {
    return {
      valid: false,
      error: 'Match has a stored identityHash but is missing the usernames needed to recompute it',
    };
  }

  const recomputed = computeIdentityHash(
    match.player1Username,
    match.player1,
    match.player2Username,
    match.player2,
  );

  if (recomputed !== match.identityHash) {
    return {
      valid: false,
      error: `Identity hash mismatch for match ${match.matchId}: the stored binding no longer matches the match's current player identities`,
    };
  }

  return { valid: true };
}

/**
 * DEPRECATED: This function is no longer used and has been removed.
 *
 * createIdentityMap assumed player1 was always white, which is incorrect.
 * Color assignment is platform-determined, and assuming a color causes
 * the identity map to be inverted when player1 is black, causing all
 * subsequent verification calls to fail.
 *
 * Instead, usernames are stored directly from the API at match creation
 * time without color assumptions. During verification, usernames are
 * compared against both registered players regardless of color assignment.
 *
 * See verifyPlayerIdentities() for the color-agnostic verification logic.
 */

/**
 * DEPRECATED: This function is no longer used and has been removed.
 *
 * normalizePlayerOrder previously attempted to detect swapped player colors
 * and "correct" the identity map. However, this approach was fundamentally
 * flawed because:
 *
 * 1. Color assignment is platform-determined and cannot be assumed
 * 2. Attempting to swap addresses based on color leads to identity confusion
 * 3. verifyPlayerIdentities() already handles color-agnostic verification
 *    by checking both (white=player1, black=player2) and (white=player2, black=player1)
 *
 * The verification logic now matches usernames to colors without modifying
 * the identity map. See verifyPlayerIdentities() for details.
 */
