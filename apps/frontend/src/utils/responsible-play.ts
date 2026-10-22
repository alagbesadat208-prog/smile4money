/**
 * Responsible-play controls (#114): self-exclusion and a per-match stake limit.
 *
 * Scope, stated plainly because players must not overestimate it (see
 * docs/responsible-play.md):
 *
 * - **Off-chain, this browser only.** Settings are kept in this browser's
 *   localStorage, keyed by wallet address. They block this app's
 *   create-match and deposit flows for that address. They do not follow the
 *   player to another browser or device, and clearing site data removes them.
 * - **Not enforced on-chain.** The escrow contract has no notion of
 *   exclusion; anyone holding the key can still call it directly or through
 *   another client. These controls are a commitment device, not a lock.
 *
 * Rules that make them worth having:
 *
 * - A self-exclusion cannot be shortened or cancelled once started; it can
 *   only be extended. It ends on its own at `until`.
 * - Lowering the stake limit applies at once. Raising or removing it applies
 *   only after {@link LIMIT_INCREASE_DELAY_MS}, so it can't be undone in the
 *   heat of the moment.
 */

import { formatStroops } from './payout';

export const SELF_EXCLUSION_PERIODS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '6m': 182 * 24 * 60 * 60 * 1000,
} as const;

export type SelfExclusionPeriod = keyof typeof SELF_EXCLUSION_PERIODS;

/** Delay before a raised or removed stake limit takes effect. */
export const LIMIT_INCREASE_DELAY_MS = 24 * 60 * 60 * 1000;

const STORAGE_PREFIX = 'smile4money:responsible-play:';

export interface ResponsiblePlaySettings {
  /** Epoch ms the self-exclusion ends; absent when none was set. */
  excludedUntil?: number;
  /** Maximum stake per match, in stroops, as a decimal string. */
  stakeLimit?: string;
  /** A raised or removed limit waiting for the delay; `null` means "remove". */
  pendingLimit?: { value: string | null; effectiveAt: number };
}

export type WagerCheck =
  | { allowed: true }
  | { allowed: false; reason: 'self_excluded'; until: number; message: string }
  | { allowed: false; reason: 'stake_limit'; limit: bigint; message: string };

export function storageKey(address: string): string {
  return `${STORAGE_PREFIX}${address}`;
}

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isStroops(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n;
}

/** Reads settings, dropping anything malformed. */
export function loadSettings(address: string): ResponsiblePlaySettings {
  let raw: unknown;
  try {
    raw = JSON.parse(store()?.getItem(storageKey(address)) ?? '{}');
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const value = raw as Record<string, unknown>;
  const settings: ResponsiblePlaySettings = {};
  if (typeof value.excludedUntil === 'number' && Number.isFinite(value.excludedUntil)) {
    settings.excludedUntil = value.excludedUntil;
  }
  if (isStroops(value.stakeLimit)) settings.stakeLimit = value.stakeLimit;
  const pending = value.pendingLimit as Record<string, unknown> | undefined;
  if (
    pending &&
    typeof pending.effectiveAt === 'number' &&
    (pending.value === null || isStroops(pending.value))
  ) {
    settings.pendingLimit = {
      value: pending.value as string | null,
      effectiveAt: pending.effectiveAt,
    };
  }
  return settings;
}

/** Settings with any pending limit change that is now due applied. */
export function effectiveSettings(address: string, now = Date.now()): ResponsiblePlaySettings {
  const settings = loadSettings(address);
  if (settings.pendingLimit && settings.pendingLimit.effectiveAt <= now) {
    const { value } = settings.pendingLimit;
    delete settings.pendingLimit;
    if (value === null) delete settings.stakeLimit;
    else settings.stakeLimit = value;
  }
  return settings;
}

/**
 * Persist settings. Returns false when storage is unavailable, so the UI can
 * say the control could not be saved instead of implying it is active.
 */
function saveSettings(address: string, settings: ResponsiblePlaySettings): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(storageKey(address), JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** Epoch ms the address is excluded until, or null when not excluded. */
export function activeExclusion(address: string, now = Date.now()): number | null {
  const until = loadSettings(address).excludedUntil;
  return until !== undefined && until > now ? until : null;
}

/**
 * Start (or extend) a self-exclusion. An existing, later end date is never
 * brought forward.
 */
export function startSelfExclusion(
  address: string,
  period: SelfExclusionPeriod,
  now = Date.now(),
): { saved: boolean; until: number } {
  const settings = effectiveSettings(address, now);
  const requested = now + SELF_EXCLUSION_PERIODS[period];
  const until = Math.max(requested, settings.excludedUntil ?? 0);
  return { saved: saveSettings(address, { ...settings, excludedUntil: until }), until };
}

/**
 * Set the per-match stake limit in stroops, or remove it with `null`.
 * Lowering (or setting a first limit) applies now; raising or removing waits
 * {@link LIMIT_INCREASE_DELAY_MS}.
 */
export function setStakeLimit(
  address: string,
  limit: bigint | null,
  now = Date.now(),
): { saved: boolean; effectiveAt: number } {
  if (limit !== null && limit <= 0n) throw new RangeError('stake limit must be positive');
  const settings = effectiveSettings(address, now);
  const current = settings.stakeLimit !== undefined ? BigInt(settings.stakeLimit) : null;
  const tightens = limit !== null && (current === null || limit <= current);

  if (tightens) {
    const next = { ...settings, stakeLimit: limit.toString() };
    delete next.pendingLimit;
    return { saved: saveSettings(address, next), effectiveAt: now };
  }
  const effectiveAt = now + LIMIT_INCREASE_DELAY_MS;
  const next = {
    ...settings,
    pendingLimit: { value: limit === null ? null : limit.toString(), effectiveAt },
  };
  return { saved: saveSettings(address, next), effectiveAt };
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

/**
 * Whether `address` may start a wager of `stake` stroops in this app. The
 * create-match and deposit flows call this before asking the wallet to sign.
 */
export function checkWagerAllowed(address: string, stake: bigint, now = Date.now()): WagerCheck {
  const until = activeExclusion(address, now);
  if (until !== null) {
    return {
      allowed: false,
      reason: 'self_excluded',
      until,
      message: `You have self-excluded from wagering until ${formatDate(until)}. This can't be undone early.`,
    };
  }
  const settings = effectiveSettings(address, now);
  if (settings.stakeLimit !== undefined) {
    const limit = BigInt(settings.stakeLimit);
    if (stake > limit) {
      return {
        allowed: false,
        reason: 'stake_limit',
        limit,
        message: `This stake is above your limit of ${formatStroops(limit)} per match.`,
      };
    }
  }
  return { allowed: true };
}
