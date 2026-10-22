/**
 * Stake, payout and fee breakdown shown before a wallet approval (#112).
 *
 * The fees that exist, from the contract and network configuration:
 *
 * - **Platform fee: none.** The escrow contract pays the whole pot to the
 *   winner (2 × stake) and refunds both stakes on a draw or a cancel
 *   (`finalize_result`, `cancel_match`, `claim_timeout` in
 *   `contracts/escrow/src/lib.rs`). {@link PLATFORM_FEE_BPS} records that
 *   and must change only if the contract starts taking a cut.
 * - **Network fee: an estimate.** Every transaction pays a Stellar fee in
 *   XLM: the inclusion fee plus, for a Soroban call, a resource fee that is
 *   only known once the wallet simulates the transaction. It is charged to
 *   the signer's XLM balance, not deducted from the stake or payout, and the
 *   wallet shows the exact amount before signing.
 *
 * Amounts are handled in stroops (bigint) so no precision is lost.
 */

export const STROOPS_PER_XLM = 10_000_000n;

/** Platform fee in basis points. The escrow contract takes no cut. */
export const PLATFORM_FEE_BPS = 0n;

/** Stellar's minimum inclusion fee per operation, in stroops. */
export const BASE_FEE_STROOPS = 100n;

/**
 * Default allowance for one Soroban contract call's resource fee, in stroops
 * (0.05 XLM). Real fees depend on the call and the network's current prices;
 * override per deployment with `VITE_ESTIMATED_RESOURCE_FEE_STROOPS`.
 */
export const DEFAULT_RESOURCE_FEE_STROOPS = 500_000n;

export type WagerAction = 'create' | 'deposit' | 'approve';

/** Wallet transactions each action asks the player to sign. */
export const TRANSACTIONS_PER_ACTION: Record<WagerAction, number> = {
  create: 1,
  deposit: 1,
  approve: 1,
};

export interface FeeConfig {
  resourceFeeStroops: bigint;
}

/** Fee configuration from the build environment, falling back to the defaults. */
export function feeConfigFromEnv(
  env: Record<string, string | undefined> = (import.meta.env ?? {}) as Record<
    string,
    string | undefined
  >,
): FeeConfig {
  const raw = env.VITE_ESTIMATED_RESOURCE_FEE_STROOPS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? BigInt(raw) : null;
  return {
    resourceFeeStroops: parsed !== null && parsed > 0n ? parsed : DEFAULT_RESOURCE_FEE_STROOPS,
  };
}

export interface OutcomeAmounts {
  /** What the contract transfers to this player. */
  gross: bigint;
  /** Gross minus this player's stake: the gain or loss on the wager. */
  net: bigint;
}

export interface PayoutBreakdown {
  stake: bigint;
  platformFee: bigint;
  win: OutcomeAmounts;
  draw: OutcomeAmounts;
  loss: OutcomeAmounts;
  /** Upper estimate of the network fee for this action, paid in XLM by the signer. */
  estimatedNetworkFee: bigint;
}

/**
 * Breakdown for one player staking `stake` stroops. Both players stake the
 * same amount, so the pot is 2 × stake.
 */
export function computePayoutBreakdown(
  stake: bigint,
  action: WagerAction,
  config: FeeConfig = feeConfigFromEnv(),
): PayoutBreakdown {
  if (stake <= 0n) throw new RangeError('stake must be positive');
  const pot = stake * 2n;
  const platformFee = (pot * PLATFORM_FEE_BPS) / 10_000n;
  const winGross = pot - platformFee;
  const perTransaction = BASE_FEE_STROOPS + config.resourceFeeStroops;
  return {
    stake,
    platformFee,
    win: { gross: winGross, net: winGross - stake },
    draw: { gross: stake, net: 0n },
    loss: { gross: 0n, net: -stake },
    estimatedNetworkFee: perTransaction * BigInt(TRANSACTIONS_PER_ACTION[action]),
  };
}

/** Stroops as a decimal string with up to 7 places, trailing zeros trimmed: 25000000n → "2.5". */
export function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const fraction = (abs % STROOPS_PER_XLM).toString().padStart(7, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Net amount with an explicit sign: "+2.5", "0", "-2.5". */
export function formatSigned(stroops: bigint): string {
  return stroops > 0n ? `+${formatStroops(stroops)}` : formatStroops(stroops);
}

/** Stroops from a user-typed XLM amount ("2.5" → 25000000n), or null when invalid. */
export function stakeFromXlmInput(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const stroops = BigInt(whole) * STROOPS_PER_XLM + BigInt(fraction.padEnd(7, '0'));
  return stroops > 0n ? stroops : null;
}

/** Stroops from an on-chain integer string ("25000000"), or null when not one. */
export function stakeFromStroops(
  value: string | number | bigint | null | undefined,
): bigint | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) && BigInt(text) > 0n ? BigInt(text) : null;
}
