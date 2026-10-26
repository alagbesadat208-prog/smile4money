/**
 * Validate-Game Service
 *
 * Contains all business logic for validating chess games on Lichess and
 * Chess.com. Route handlers in routes/validate-game.ts delegate here so that
 * the logic can be tested independently of HTTP concerns.
 */

import { fetchLichessResult, GameNotFoundError } from '../fetchers/lichess.js';
import { fetchChessDotComResult } from '../fetchers/chessdotcom.js';
import type { MatchResult, GameResult } from '../fetchers/lichess.js';
import { errorToHttpStatus } from '../errors/errorToHttpStatus.js';
import {
  checkGameEligibility,
  type EligibilityRejection,
  type GameMetadata,
} from './game-eligibility.js';

export interface ValidateGameInput {
  gameId: string;
  platform: string;
  username?: string;
}

export interface ValidateGameSuccess {
  ok: true;
  valid: true;
  platform: string;
  gameId: string;
  status?: string;
  whitePlayer?: string;
  blackPlayer?: string;
  result?: MatchResult | null;
}

export interface ValidateGameNotFound {
  ok: false;
  status: number;
  valid: false;
  platform: string;
  gameId: string;
  message: string;
}

export interface ValidateGameError {
  ok: false;
  status: number;
  error?: string;
  valid?: false;
  platform?: string;
  gameId?: string;
  message?: string;
}

/** The game exists but breaks a rule in docs/supported-games.md (#110). */
export interface ValidateGameIneligible {
  ok: false;
  status: 422;
  valid: false;
  platform: string;
  gameId: string;
  message: string;
  rejections: EligibilityRejection[];
}

export type ValidateGameResult =
  | ValidateGameSuccess
  | ValidateGameNotFound
  | ValidateGameIneligible
  | ValidateGameError;

/**
 * A fetched game, optionally carrying provider metadata (variant, time
 * control, clock) for the eligibility rules. Fetchers that do not attach it
 * yet are checked on `status` alone.
 */
type FetchedGame = GameResult & { metadata?: GameMetadata };

/**
 * Apply the eligibility rules to a fetched game. Returns the rejection
 * response, or null when the game is eligible.
 */
function ineligibleResponse(
  platform: string,
  gameId: string,
  game: FetchedGame,
): ValidateGameIneligible | null {
  const { eligible, rejections } = checkGameEligibility({
    ...game.metadata,
    status: game.status,
  });
  if (eligible) return null;
  return {
    ok: false,
    status: 422,
    valid: false,
    platform,
    gameId,
    message: rejections.map((r) => r.message).join(' '),
    rejections,
  };
}

/**
 * Validate the input fields for a game-validation request.
 *
 * Returns an error string if validation fails, or null if valid.
 */
export function validateGameInput(input: Partial<ValidateGameInput>): string | null {
  const { gameId, platform, username } = input;

  if (!gameId || typeof gameId !== 'string' || gameId.length === 0) {
    return 'gameId is required';
  }
  if (gameId.length >= 512) {
    return 'gameId is too long';
  }
  if (!platform || (platform !== 'lichess' && platform !== 'chessdotcom')) {
    return 'platform must be lichess or chessdotcom';
  }
  if (platform === 'chessdotcom' && (!username || typeof username !== 'string' || username.length === 0)) {
    return 'username is required for chessdotcom validation to look up game archives';
  }
  return null;
}

/**
 * Validate that a chess game exists on the given platform, meets the
 * eligibility rules (docs/supported-games.md), and return its details.
 *
 * Assumes input has already been validated by `validateGameInput`.
 */
export async function validateGame(input: ValidateGameInput): Promise<ValidateGameResult> {
  const { gameId, platform, username } = input;

  try {
    if (platform === 'lichess') {
      const result = await fetchLichessResult(gameId);
      const ineligible = ineligibleResponse('lichess', result.gameId, result);
      if (ineligible) return ineligible;
      return {
        ok: true,
        valid: true,
        platform: 'lichess',
        gameId: result.gameId,
        status: result.status,
        whitePlayer: result.whitePlayer,
        blackPlayer: result.blackPlayer,
        result: result.result,
      };
    } else {
      // chessdotcom — username already validated by validateGameInput
      const result = await fetchChessDotComResult(username as string, gameId);
      const ineligible = ineligibleResponse('chessdotcom', result.gameId, result);
      if (ineligible) return ineligible;
      return {
        ok: true,
        valid: true,
        platform: 'chessdotcom',
        gameId: result.gameId,
        status: result.status,
        whitePlayer: result.whitePlayer,
        blackPlayer: result.blackPlayer,
        result: result.result,
      };
    }
  } catch (error) {
    if (error instanceof GameNotFoundError) {
      return {
        ok: false,
        status: errorToHttpStatus(error),
        valid: false,
        platform,
        gameId,
        message: error.message,
      };
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      ok: false,
      status: errorToHttpStatus(error),
      valid: false,
      platform,
      gameId,
      message: `Validation failed: ${message}`,
    };
  }
}
