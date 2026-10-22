/**
 * Responsible play in the deposit flow (#114): a self-excluded player, or a
 * stake above the player's limit, never reaches the wallet.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DepositStake } from '../src/components/DepositStake';
import { setStakeLimit, startSelfExclusion } from '../src/utils/responsible-play';

// Same @stellar/stellar-sdk mock as DepositStake.test.tsx, so get_match
// resolves without a live RPC server.
const { defaultMatch, setSimulateResponse, getSimulateResponse } = vi.hoisted(() => {
  const defaultMatch = {
    id: 0n,
    player1: 'GPLAYERONE',
    player2: 'GPLAYERTWO',
    stake_amount: 10000000n,
    // Matches the value returned by the mocked Asset.native().contractId()
    token: 'NATIVE-XLM-TOKEN',
    game_id: 'lichess_abc123',
    platform: 'Lichess',
    state: 'Pending',
    player1_deposited: false,
    player2_deposited: false,
    created_ledger: 40000n,
    timeout_ledgers: 120_960n,
  };

  let simulateResponse: unknown = { result: { retval: defaultMatch } };

  return {
    defaultMatch,
    setSimulateResponse: (response: unknown) => {
      simulateResponse = response;
    },
    getSimulateResponse: () => simulateResponse,
  };
});

// Mock @stellar/stellar-sdk so DepositStake's read-only get_match simulation
// can run without a live Soroban RPC server.
vi.mock('@stellar/stellar-sdk', () => ({
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  },
  rpc: {
    Server: vi.fn().mockImplementation(() => ({
      simulateTransaction: vi.fn().mockImplementation(async () => getSimulateResponse()),
      getLedgers: vi.fn().mockImplementation(() => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: [{ sequence: '50000' }],
            }),
          }),
        }),
      })),
    })),
  },
  Account: class Account {
    constructor(_accountId: string, _sequence: string) {}
  },
  Operation: {
    invokeContractFunction: vi.fn((opts) => opts),
  },
  TransactionBuilder: class TransactionBuilder {
    addOperation() {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return {};
    }
  },
  nativeToScVal: vi.fn((value) => value),
  scValToNative: vi.fn((value) => value),
  Asset: {
    native: () => ({
      contractId: () => 'NATIVE-XLM-TOKEN',
    }),
  },
}));

const PLAYER = 'GPLAYERONE';

beforeEach(() => {
  window.localStorage.clear();
  setSimulateResponse({ result: { retval: defaultMatch } });
});
afterEach(() => window.localStorage.clear());

async function renderLoaded(onDeposit: () => Promise<void>) {
  render(
    <DepositStake
      matchId="7"
      playerAddress={PLAYER}
      contractId="test-contract"
      onDeposit={onDeposit}
      allowanceSufficient
    />,
  );
  await screen.findByTestId('match-info');
  return screen.getByTestId('deposit-btn');
}

describe('DepositStake responsible play (#114)', () => {
  it('blocks a self-excluded player before the wallet is asked to sign', async () => {
    startSelfExclusion(PLAYER, '24h');
    const onDeposit = vi.fn().mockResolvedValue(undefined);

    fireEvent.click(await renderLoaded(onDeposit));

    expect(onDeposit).not.toHaveBeenCalled();
    expect(await screen.findByText(/self-excluded from wagering/i)).toBeInTheDocument();
  });

  it('blocks a stake above the limit', async () => {
    setStakeLimit(PLAYER, 5_000_000n);
    const onDeposit = vi.fn().mockResolvedValue(undefined);

    fireEvent.click(await renderLoaded(onDeposit));

    expect(onDeposit).not.toHaveBeenCalled();
    expect(await screen.findByText(/above your limit/i)).toBeInTheDocument();
  });

  it('deposits normally with no controls set, after showing the breakdown', async () => {
    const onDeposit = vi.fn().mockResolvedValue(undefined);

    const button = await renderLoaded(onDeposit);
    expect(screen.getByTestId('payout-stake')).toHaveTextContent('1 XLM');
    fireEvent.click(button);

    expect(onDeposit).toHaveBeenCalledWith('7');
  });
});
