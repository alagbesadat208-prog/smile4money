/**
 * Backend binding to the deployed contracts' interface (#120).
 *
 * Generated fixture: contracts/interface/contract-interface.json, produced by
 * `node scripts/generate-contract-interface.mjs` from the contract sources.
 * The frontend (`apps/frontend/src/contract/contract-interface.ts`) has an equivalent module, and both are tested against
 * that one fixture, so the two clients cannot drift apart or away from the
 * contract without a failing test.
 *
 * When the fixture changes, review every method and error below against it,
 * then set {@link CONTRACT_INTERFACE_SPEC_HASH} to the new `specHash`.
 */
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { MatchResult } from '../fetchers/lichess.js';

/** `specHash` of the fixture this module was last reviewed against. */
export const CONTRACT_INTERFACE_SPEC_HASH = '40b1543545c2d06c';

/**
 * Escrow contract error codes (`contracts/escrow/src/errors.rs`). Must match
 * the shared fixture exactly; see the module comment.
 *
 * Note: the contract currently assigns code 28 to both TokenNotAllowlisted
 * and DisputeWindowExpired. The table mirrors the contract as written;
 * {@link escrowErrorName} reports the first name for a shared code.
 */
export const ESCROW_ERRORS = {
  MatchNotFound: 1,
  AlreadyFunded: 2,
  NotFunded: 3,
  Unauthorized: 4,
  InvalidState: 5,
  AlreadyExists: 6,
  AlreadyInitialized: 7,
  Overflow: 8,
  ContractPaused: 9,
  InvalidAmount: 10,
  InvalidGameId: 11,
  InvalidPlayers: 12,
  GameIdMismatch: 13,
  DuplicateGameId: 14,
  TransferFailed: 15,
  MatchCancelled: 16,
  MatchCompleted: 17,
  NotPaused: 18,
  InsufficientAllowance: 19,
  DisputeWindowActive: 20,
  MatchTimedOut: 21,
  InvalidToken: 22,
  InvalidAdmin: 23,
  StakeTooLow: 24,
  StakeTooHigh: 25,
  InsufficientReserve: 26,
  InvalidAddress: 27,
  TokenNotAllowlisted: 28,
  TokenAlreadyListed: 29,
  TokenNotListed: 30,
  CannotRemoveDefault: 31,
  InvalidStakeAmount: 32,
  ActiveMatchExists: 33,
  DisputeWindowExpired: 28,
} as const;

/** Leaderboard contract error codes (`contracts/leaderboard/src/types.rs`). */
export const LEADERBOARD_ERRORS = {
  AlreadyInitialized: 1,
  Unauthorized: 2,
  NotInitialized: 3,
  InvalidResult: 4,
  InvalidRange: 5,
  ContractPaused: 6,
} as const;

export type EscrowErrorName = keyof typeof ESCROW_ERRORS;
export type LeaderboardErrorName = keyof typeof LEADERBOARD_ERRORS;

function nameByCode<T extends Record<string, number>>(errors: T): Map<number, keyof T & string> {
  const names = new Map<number, keyof T & string>();
  for (const [name, code] of Object.entries(errors)) {
    if (!names.has(code)) names.set(code, name as keyof T & string);
  }
  return names;
}

const ESCROW_ERROR_NAMES = nameByCode(ESCROW_ERRORS);
const LEADERBOARD_ERROR_NAMES = nameByCode(LEADERBOARD_ERRORS);

/** Name of an escrow contract error code, or undefined for an unknown code. */
export function escrowErrorName(code: number): EscrowErrorName | undefined {
  return ESCROW_ERROR_NAMES.get(code);
}

/** Name of a leaderboard contract error code, or undefined for an unknown code. */
export function leaderboardErrorName(code: number): LeaderboardErrorName | undefined {
  return LEADERBOARD_ERROR_NAMES.get(code);
}

/** Escrow `Winner` enum variants. */
export const ESCROW_WINNERS = ['Player1', 'Player2', 'Draw'] as const;
export type EscrowWinner = (typeof ESCROW_WINNERS)[number];

/** The backend's result names, mapped to the contract's `Winner` variants. */
export function toEscrowWinner(result: MatchResult): EscrowWinner {
  switch (result) {
    case 'Player1Wins':
      return 'Player1';
    case 'Player2Wins':
      return 'Player2';
    case 'Draw':
      return 'Draw';
  }
}

/** A unit `#[contracttype]` enum value is encoded as a one-symbol vector. */
export function unitEnumToScVal(variant: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);
}

/** Escrow methods the backend invokes, with their argument order. */
export const BACKEND_ESCROW_METHODS = {
  submit_result: ['match_id', 'game_id', 'winner', 'caller'],
} as const;

export interface SubmitResultArgs {
  matchId: number | bigint;
  gameId: string;
  result: MatchResult;
  /** The oracle's account address (G...). */
  caller: string;
}

/** Arguments for `submit_result(match_id: u64, game_id: String, winner: Winner, caller: Address)`. */
export function serializeSubmitResultArgs(args: SubmitResultArgs): xdr.ScVal[] {
  return [
    nativeToScVal(BigInt(args.matchId), { type: 'u64' }),
    nativeToScVal(args.gameId, { type: 'string' }),
    unitEnumToScVal(toEscrowWinner(args.result)),
    new Address(args.caller).toScVal(),
  ];
}
