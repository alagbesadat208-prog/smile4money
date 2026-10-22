import {
  computePayoutBreakdown,
  formatSigned,
  formatStroops,
  type FeeConfig,
  type WagerAction,
} from '../utils/payout';

interface PayoutBreakdownProps {
  /** This player's stake, in stroops; nothing is shown until it is valid. */
  stake: bigint | null;
  /** Stake token symbol, e.g. "XLM" or "USDC". */
  token: string;
  action: WagerAction;
  /** Override the fee configuration (tests). */
  feeConfig?: FeeConfig;
}

/**
 * Stake, gross and net payout per outcome, platform fee and the estimated
 * network fee, shown before the wallet is asked to sign (#112). The network
 * fee is labelled an estimate: the wallet shows the exact amount.
 */
export function PayoutBreakdown({ stake, token, action, feeConfig }: PayoutBreakdownProps) {
  if (stake === null || stake <= 0n) return null;
  const b = computePayoutBreakdown(stake, action, feeConfig);
  const unit = token.toUpperCase();

  return (
    <section
      className="payout-breakdown"
      aria-label="Payout and fees"
      data-testid="payout-breakdown"
    >
      <h4>Before you sign</h4>
      <table>
        <tbody>
          <tr>
            <th scope="row">Your stake</th>
            <td data-testid="payout-stake">
              {formatStroops(b.stake)} {unit}
            </td>
          </tr>
          <tr>
            <th scope="row">Platform fee</th>
            <td data-testid="payout-platform-fee">
              {formatStroops(b.platformFee)} {unit} (the escrow contract takes no cut)
            </td>
          </tr>
        </tbody>
      </table>

      <table>
        <thead>
          <tr>
            <th scope="col">Outcome</th>
            <th scope="col">You receive (gross)</th>
            <th scope="col">Net on your stake</th>
          </tr>
        </thead>
        <tbody>
          <tr data-testid="payout-win">
            <th scope="row">You win</th>
            <td>
              {formatStroops(b.win.gross)} {unit}
            </td>
            <td>
              {formatSigned(b.win.net)} {unit}
            </td>
          </tr>
          <tr data-testid="payout-draw">
            <th scope="row">Draw</th>
            <td>
              {formatStroops(b.draw.gross)} {unit}
            </td>
            <td>
              {formatSigned(b.draw.net)} {unit}
            </td>
          </tr>
          <tr data-testid="payout-loss">
            <th scope="row">You lose</th>
            <td>
              {formatStroops(b.loss.gross)} {unit}
            </td>
            <td>
              {formatSigned(b.loss.net)} {unit}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="field-hint" data-testid="payout-network-fee">
        Estimated network fee for this step: up to about {formatStroops(b.estimatedNetworkFee)} XLM,
        paid from your XLM balance and not taken from the stake or payout. This is an estimate; your
        wallet shows the exact fee before you approve.
      </p>
    </section>
  );
}

export default PayoutBreakdown;
