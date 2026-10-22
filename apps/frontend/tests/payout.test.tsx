/**
 * Fee and net-payout breakdown (#112): which fees exist, how they are
 * calculated from configuration, and that the network fee is shown as an
 * estimate rather than an exact amount.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PayoutBreakdown } from '../src/components/PayoutBreakdown';
import {
  BASE_FEE_STROOPS,
  DEFAULT_RESOURCE_FEE_STROOPS,
  PLATFORM_FEE_BPS,
  computePayoutBreakdown,
  feeConfigFromEnv,
  formatSigned,
  formatStroops,
  stakeFromStroops,
  stakeFromXlmInput,
} from '../src/utils/payout';

const CONFIG = { resourceFeeStroops: 500_000n };

describe('computePayoutBreakdown', () => {
  it('charges no platform fee and pays the winner the whole pot', () => {
    expect(PLATFORM_FEE_BPS).toBe(0n);
    const b = computePayoutBreakdown(25_000_000n, 'create', CONFIG);
    expect(b.platformFee).toBe(0n);
    expect(b.win).toEqual({ gross: 50_000_000n, net: 25_000_000n });
  });

  it('refunds the stake on a draw and loses it on a loss', () => {
    const b = computePayoutBreakdown(25_000_000n, 'deposit', CONFIG);
    expect(b.draw).toEqual({ gross: 25_000_000n, net: 0n });
    expect(b.loss).toEqual({ gross: 0n, net: -25_000_000n });
  });

  it('estimates the network fee from the base fee and the configured resource fee', () => {
    expect(computePayoutBreakdown(1n, 'create', CONFIG).estimatedNetworkFee).toBe(
      BASE_FEE_STROOPS + 500_000n,
    );
    expect(
      computePayoutBreakdown(1n, 'deposit', { resourceFeeStroops: 1_000n }).estimatedNetworkFee,
    ).toBe(BASE_FEE_STROOPS + 1_000n);
  });

  it('keeps stroop precision for tiny and huge stakes', () => {
    expect(computePayoutBreakdown(1n, 'create', CONFIG).win.gross).toBe(2n);
    const huge = 10_000_000_000_000n;
    expect(computePayoutBreakdown(huge, 'create', CONFIG).win.gross).toBe(huge * 2n);
  });

  it('rejects a non-positive stake', () => {
    expect(() => computePayoutBreakdown(0n, 'create', CONFIG)).toThrow(RangeError);
  });
});

describe('feeConfigFromEnv', () => {
  it('reads the configured resource fee', () => {
    expect(feeConfigFromEnv({ VITE_ESTIMATED_RESOURCE_FEE_STROOPS: '250000' })).toEqual({
      resourceFeeStroops: 250_000n,
    });
  });

  it('falls back to the default for missing or invalid values', () => {
    for (const value of [undefined, '', 'lots', '-5', '0', '1.5']) {
      expect(
        feeConfigFromEnv({ VITE_ESTIMATED_RESOURCE_FEE_STROOPS: value }).resourceFeeStroops,
      ).toBe(DEFAULT_RESOURCE_FEE_STROOPS);
    }
  });
});

describe('amount helpers', () => {
  it('formats stroops as decimal amounts', () => {
    expect(formatStroops(25_000_000n)).toBe('2.5');
    expect(formatStroops(1n)).toBe('0.0000001');
    expect(formatStroops(-10_000_000n)).toBe('-1');
    expect(formatSigned(10_000_000n)).toBe('+1');
    expect(formatSigned(0n)).toBe('0');
  });

  it('parses typed XLM amounts and on-chain stroops', () => {
    expect(stakeFromXlmInput(' 2.5 ')).toBe(25_000_000n);
    expect(stakeFromXlmInput('0.0000001')).toBe(1n);
    for (const bad of ['', '0', 'abc', '1.12345678', '-1'])
      expect(stakeFromXlmInput(bad)).toBeNull();
    expect(stakeFromStroops('25000000')).toBe(25_000_000n);
    expect(stakeFromStroops(10n)).toBe(10n);
    expect(stakeFromStroops('1.5')).toBeNull();
    expect(stakeFromStroops(undefined)).toBeNull();
  });
});

describe('<PayoutBreakdown>', () => {
  it('shows stake, platform fee, gross and net per outcome', () => {
    render(<PayoutBreakdown stake={25_000_000n} token="xlm" action="create" feeConfig={CONFIG} />);
    expect(screen.getByTestId('payout-stake')).toHaveTextContent('2.5 XLM');
    expect(screen.getByTestId('payout-platform-fee')).toHaveTextContent('0 XLM');
    expect(screen.getByTestId('payout-win')).toHaveTextContent('5 XLM');
    expect(screen.getByTestId('payout-win')).toHaveTextContent('+2.5 XLM');
    expect(screen.getByTestId('payout-draw')).toHaveTextContent('2.5 XLM');
    expect(screen.getByTestId('payout-loss')).toHaveTextContent('-2.5 XLM');
  });

  it('labels the network fee as an estimate, not an exact amount', () => {
    render(
      <PayoutBreakdown stake={25_000_000n} token="usdc" action="deposit" feeConfig={CONFIG} />,
    );
    const fee = screen.getByTestId('payout-network-fee');
    expect(fee).toHaveTextContent('up to about 0.05001 XLM');
    expect(fee).toHaveTextContent(/estimate/i);
    expect(fee).toHaveTextContent(/wallet shows the exact fee/i);
    expect(fee).toHaveTextContent(/not taken from the stake or payout/i);
  });

  it('renders nothing without a valid stake', () => {
    const { container } = render(<PayoutBreakdown stake={null} token="xlm" action="create" />);
    expect(container).toBeEmptyDOMElement();
  });
});
