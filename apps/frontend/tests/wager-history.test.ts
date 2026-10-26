// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Asset, Networks } from '@stellar/stellar-sdk';
import { wagerRow, type EscrowMatch } from '../src/pages/wager-history';
import { formatTokenAmount } from '../src/token-amount';
import { setupState } from '../src/deployment';

const match: EscrowMatch = {
  id: 42n,
  player1: 'alice',
  player2: 'bob',
  stake_amount: 15000000n,
  token: Asset.native().contractId(Networks.TESTNET),
  state: ['Completed'],
  pending_winner: ['Some', ['Player1']],
  player1_deposited: true,
  player2_deposited: true,
};
describe('escrow wager outcomes', () => {
  it('reads win and loss payouts from the completed match', () => {
    expect(wagerRow(match, 'alice')).toMatchObject({
      result: 'Win',
      stake: '1.5 XLM',
      payout: '3 XLM',
    });
    expect(wagerRow(match, 'bob')).toMatchObject({ result: 'Loss', payout: '0 XLM' });
  });
  it('returns one stake on a draw', () => {
    expect(wagerRow({ ...match, pending_winner: ['Some', ['Draw']] }, 'alice')).toMatchObject({
      result: 'Draw',
      payout: '1.5 XLM',
    });
  });
  it('refunds only deposited stakes on cancellation', () => {
    expect(wagerRow({ ...match, state: ['Cancelled'] }, 'alice')).toMatchObject({
      result: 'Refund',
      payout: '1.5 XLM',
    });
    expect(
      wagerRow({ ...match, state: ['Cancelled'], player1_deposited: false }, 'alice'),
    ).toMatchObject({ payout: '0 XLM' });
  });
  it('excludes unrelated players and never settles pending results', () => {
    expect(wagerRow(match, 'unrelated')).toBeNull();
    expect(wagerRow({ ...match, state: ['PendingResult'] }, 'alice')?.payout).toBe('Pending');
  });
});
describe('trusted token denominations', () => {
  it('formats native smallest units exactly, including large values', () => {
    expect(formatTokenAmount('9007199254740993', match.token, Networks.TESTNET)).toBe(
      '900719925.4740993 XLM',
    );
    expect(formatTokenAmount('1', match.token, Networks.TESTNET)).toBe('0.0000001 XLM');
  });
  it('does not guess unknown or cross-network assets', () => {
    expect(formatTokenAmount('1234', 'CTOKEN', Networks.TESTNET)).toBe(
      '1234 smallest units (CTOKEN)',
    );
    expect(formatTokenAmount('1234', match.token, Networks.PUBLIC)).toContain('smallest units');
  });
});
describe('deployment setup', () => {
  it('requires connection', () =>
    expect(setupState('disconnected', 'unknown', true, 'testnet')).toBe('disconnected'));
  it('blocks unsupported and unknown wallet networks', () => {
    expect(setupState('connected', 'mainnet', true, 'testnet')).toBe('unsupported');
    expect(setupState('connected', 'unknown', true, 'testnet')).toBe('unsupported');
  });
  it('requires a configured deployment', () =>
    expect(setupState('connected', 'testnet', false, 'testnet')).toBe('unconfigured'));
  it('is ready only on the configured network', () =>
    expect(setupState('connected', 'mainnet', true, 'mainnet')).toBe('ready'));
});
