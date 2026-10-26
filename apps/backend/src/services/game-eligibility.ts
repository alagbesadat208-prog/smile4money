/**
 * Game eligibility rules (#110).
 *
 * Which games the oracle can verify, and so which games a wager may be
 * staked on. The user-facing statement of these rules is
 * docs/supported-games.md; every condition there that a machine can check is
 * encoded here, and each rejection carries a stable code and a message that
 * says what to change.
 *
 * Rules:
 * - Platform: Lichess or Chess.com.
 * - Variant: standard chess only (no Chess960, no custom starting position,
 *   no other variants).
 * - Time control: a real-time game with a clock — bullet, blitz, rapid or
 *   classical. Correspondence / daily and unlimited games are rejected: they
 *   can outlast the wager's on-chain timeout.
 * - Visibility: the game must be publicly readable through the platform's
 *   API. A private or deleted game cannot be fetched, so it is rejected as
 *   not found before these rules run.
 * - Completion: an in-progress game is eligible (the oracle polls until it
 *   ends), but a finished game must end in a way that produces a verifiable
 *   result. Aborted games, games that never started and games with an
 *   unknown finish are rejected; they have no outcome to settle.
 *
 * Metadata fields are optional: a rule only runs when the field it needs is
 * present. Fetchers pass what their provider returns; the `*Metadata` parsers
 * below turn a raw provider payload into this shape.
 */

/** Variant names, normalised across platforms. */
export const SUPPORTED_VARIANTS = ['standard'] as const;

/** Time-control classes, normalised across platforms. */
export const SUPPORTED_SPEEDS = ['bullet', 'blitz', 'rapid', 'classical'] as const;

/** Speeds that can never be settled within the wager timeout. */
export const UNSUPPORTED_SPEEDS = ['correspondence', 'daily', 'unlimited'] as const;

/**
 * Lichess end states with no verifiable outcome. The fetcher may still map
 * some of these to a result; eligibility rejects them so no wager is staked
 * on one.
 */
export const UNVERIFIABLE_END_STATUSES = ['aborted', 'noStart', 'unknownFinish'] as const;

export type EligibilityRejectionCode =
  | 'UNSUPPORTED_VARIANT'
  | 'UNSUPPORTED_TIME_CONTROL'
  | 'NO_CLOCK'
  | 'UNVERIFIABLE_COMPLETION';

export interface EligibilityRejection {
  code: EligibilityRejectionCode;
  message: string;
}

export interface GameMetadata {
  /** Provider status string, e.g. `mate`, `started`, `aborted`, `finished`. */
  status?: string;
  /** Normalised variant name, e.g. `standard`, `chess960`. */
  variant?: string;
  /** Normalised time-control class, e.g. `blitz`, `correspondence`. */
  speed?: string;
  /** Initial clock in seconds; `null` when the game has no clock. */
  initialSeconds?: number | null;
}

export interface EligibilityResult {
  eligible: boolean;
  rejections: EligibilityRejection[];
}

const includes = (list: readonly string[], value: string): boolean => list.includes(value);

/**
 * Check a game against the eligibility rules. Returns every rejection, in a
 * fixed order (variant, time control, clock, completion), so the response is
 * deterministic and the user sees all problems at once.
 */
export function checkGameEligibility(game: GameMetadata): EligibilityResult {
  const rejections: EligibilityRejection[] = [];

  if (game.variant !== undefined && !includes(SUPPORTED_VARIANTS, game.variant)) {
    rejections.push({
      code: 'UNSUPPORTED_VARIANT',
      message: `Variant "${game.variant}" is not supported; only standard chess can be wagered on.`,
    });
  }

  if (game.speed !== undefined && !includes(SUPPORTED_SPEEDS, game.speed)) {
    rejections.push({
      code: 'UNSUPPORTED_TIME_CONTROL',
      message: `Time control "${game.speed}" is not supported; use a bullet, blitz, rapid or classical game.`,
    });
  }

  if (game.initialSeconds === null) {
    rejections.push({
      code: 'NO_CLOCK',
      message: 'Games without a clock are not supported; play with a time control.',
    });
  }

  if (game.status !== undefined && includes(UNVERIFIABLE_END_STATUSES, game.status)) {
    rejections.push({
      code: 'UNVERIFIABLE_COMPLETION',
      message: `The game ended as "${game.status}", which has no verifiable result.`,
    });
  }

  return { eligible: rejections.length === 0, rejections };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Metadata from a Lichess game export (`/game/export/{id}` or
 * `/api/game/{id}` JSON): `variant`, `speed`, `status`, `clock.initial`.
 * Lichess calls a custom starting position `fromPosition`, which is not
 * standard chess.
 */
export function lichessMetadata(raw: unknown): GameMetadata {
  if (!isRecord(raw)) return {};
  const meta: GameMetadata = {};
  if (typeof raw.status === 'string') meta.status = raw.status;
  if (typeof raw.variant === 'string') meta.variant = raw.variant;
  if (typeof raw.speed === 'string') meta.speed = raw.speed;
  if (isRecord(raw.clock) && typeof raw.clock.initial === 'number') {
    meta.initialSeconds = raw.clock.initial;
  } else if (meta.speed === 'correspondence' || meta.speed === 'unlimited') {
    meta.initialSeconds = null;
  }
  return meta;
}

/**
 * Metadata from a Chess.com archive game: `rules` (`chess`, `chess960`, …),
 * `time_class` (`bullet`, `blitz`, `rapid`, `daily`) and `time_control`
 * (`"180+2"`, or `"1/86400"` for daily games).
 */
export function chessDotComMetadata(raw: unknown): GameMetadata {
  if (!isRecord(raw)) return {};
  const meta: GameMetadata = {};
  if (typeof raw.rules === 'string') {
    meta.variant = raw.rules === 'chess' ? 'standard' : raw.rules;
  }
  if (typeof raw.time_class === 'string') meta.speed = raw.time_class;
  if (typeof raw.time_control === 'string') {
    const match = /^(\d+)(?:\+\d+)?$/.exec(raw.time_control);
    // Daily games are "moves/seconds" and have no game clock.
    meta.initialSeconds = match ? Number(match[1]) : null;
  }
  return meta;
}
