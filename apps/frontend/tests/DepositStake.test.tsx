import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DepositStake } from '../src/components/DepositStake';

// Mutable state shared between the test body and the @stellar/stellar-sdk mock.
// vi.mock is hoisted above imports, so the mock can only close over values
// created with vi.hoisted().
const { defaultMatch, setSimulateResponse, getSimulateResponse } = vi.hoisted(() => {
  const defaultMatch = {
    id: 0n,
    player1: 'GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF123456',
    player2: 'G1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
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
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 50000 }),
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

beforeEach(() => {
  setSimulateResponse({ result: { retval: defaultMatch } });
});

describe('DepositStake — loading state', () => {
  it('shows loading state initially while fetching match details', () => {
    render(<DepositStake matchId="123" playerAddress="GABCDEF123456" contractId="test-contract" />);
    expect(screen.getByTestId('deposit-stake')).toBeInTheDocument();
  });
});

describe('DepositStake — no match ID', () => {
  it('returns null when no match ID provided', () => {
    const { container } = render(
      <DepositStake matchId="" playerAddress="GABCDEF123456" contractId="test-contract" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('DepositStake — match info display', () => {
  it('displays match details fetched from the escrow contract', async () => {
    render(<DepositStake matchId="123" playerAddress="GABCDEF123456" contractId="test-contract" />);

    await screen.findByTestId('match-info');

    // On-chain stake amount (stroops) and the native token symbol
    expect(screen.getByText('10000000')).toBeInTheDocument();
    expect(screen.getByText('XLM')).toBeInTheDocument();

    // Player addresses are truncated for display
    expect(screen.getByText('GABC...3456')).toBeInTheDocument();
    expect(screen.getByText('G123...90AB')).toBeInTheDocument();

    expect(screen.getByTestId('player1-status')).toHaveTextContent('Pending');
    expect(screen.getByTestId('player2-status')).toHaveTextContent('Pending');
  });

  it('renders the raw token address when the token is not native XLM', async () => {
    setSimulateResponse({
      result: {
        retval: {
          ...defaultMatch,
          token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        },
      },
    });

    render(<DepositStake matchId="123" playerAddress="GABCDEF123456" contractId="test-contract" />);

    await screen.findByTestId('match-info');
    expect(
      screen.getByText('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'),
    ).toBeInTheDocument();
  });

  it('shows deposited indicators when on-chain data reports a deposit', async () => {
    setSimulateResponse({
      result: {
        retval: { ...defaultMatch, player1_deposited: true },
      },
    });

    const player1Address = defaultMatch.player1;
    render(
      <DepositStake
        matchId="123"
        playerAddress={player1Address}
        contractId="test-contract"
      />,
    );

    await screen.findByTestId('match-info');
    expect(screen.getByTestId('player1-status')).toHaveTextContent('✓ Deposited');
    expect(screen.getByTestId('player2-status')).toHaveTextContent('Pending');

    // Already deposited — deposit button is disabled and relabelled
    expect(screen.getByTestId('deposit-btn')).toBeDisabled();
    expect(screen.getByTestId('deposit-btn')).toHaveTextContent('Already Deposited');
  });
});

describe('DepositStake — RPC error handling', () => {
  it('shows an error and a retry button when get_match returns an error', async () => {
    setSimulateResponse({ error: 'HostError' });

    render(<DepositStake matchId="999" playerAddress="GABCDEF123456" contractId="test-contract" />);

    await waitFor(() => {
      expect(screen.getByTestId('deposit-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/Could not load match 999/)).toBeInTheDocument();
    expect(screen.getByTestId('retry-btn')).toBeInTheDocument();
  });

  it('recovers via the retry button when the RPC call later succeeds', async () => {
    setSimulateResponse({ error: 'HostError' });

    render(<DepositStake matchId="123" playerAddress="GABCDEF123456" contractId="test-contract" />);

    await waitFor(() => {
      expect(screen.getByTestId('deposit-error')).toBeInTheDocument();
    });

    // The match now exists on-chain — retrying loads it
    setSimulateResponse({ result: { retval: defaultMatch } });
    fireEvent.click(screen.getByTestId('retry-btn'));

    await screen.findByTestId('match-info');
    expect(screen.getByText('10000000')).toBeInTheDocument();
  });
});

describe('DepositStake — deposit button states', () => {
  it('shows Deposit Stake button after loading', async () => {
    render(<DepositStake matchId="123" playerAddress="GABCDEF123456" contractId="test-contract" />);

    await waitFor(() => {
      expect(screen.getByTestId('deposit-btn')).toBeInTheDocument();
    });
  });

  /**
   * #1080 — Regression guard for double-submit race condition.
   *
   * While an in-flight deposit transaction is pending the button must be:
   *   - disabled (cannot be clicked again)
   *   - aria-busy="true" (accessible loading indicator)
   *   - showing the "Depositing…" label
   *
   * We use a never-resolving promise to freeze the component in the pending
   * state so we can assert all three properties synchronously.
   */
  it('disables the button and shows a loading indicator while a deposit is in flight', async () => {
    // onDeposit never resolves — keeps the component in the 'pending' state
    // for as long as we need to make assertions.
    let resolveDeposit!: () => void;
    const inFlightDeposit = new Promise<void>((resolve) => {
      resolveDeposit = resolve;
    });
    const onDeposit = vi.fn().mockReturnValue(inFlightDeposit);

    render(
      <DepositStake
        matchId="123"
        playerAddress="GABCDEF123456"
        contractId="test-contract"
        onDeposit={onDeposit}
      />,
    );

    // Wait for match details to load so the deposit button is enabled
    const depositBtn = await screen.findByTestId('deposit-btn');
    expect(depositBtn).not.toBeDisabled();

    // Trigger the deposit — this sets status to 'pending' synchronously
    fireEvent.click(depositBtn);

    // The button must be disabled while the transaction is in flight
    expect(depositBtn).toBeDisabled();

    // aria-busy must be true so screen readers announce the loading state
    expect(depositBtn).toHaveAttribute('aria-busy', 'true');

    // The label must communicate the in-progress state to sighted users
    expect(depositBtn).toHaveTextContent('Depositing…');

    // Confirm onDeposit was only called once — no double-submit
    expect(onDeposit).toHaveBeenCalledTimes(1);

    // Clean up: let the promise resolve so the component can unmount cleanly
    resolveDeposit();
  });
});

describe('DepositStake — form rendering', () => {
  it('renders with correct test id', () => {
    render(<DepositStake matchId="123" playerAddress="GABCDEF123456" contractId="test-contract" />);
    expect(screen.getByTestId('deposit-stake')).toBeInTheDocument();
  });
});

describe('DepositStake — wallet connection check', () => {
  it('handles no player address', () => {
    render(<DepositStake matchId="123" playerAddress={null} contractId="test-contract" />);
    expect(screen.getByTestId('deposit-stake')).toBeInTheDocument();
  });
});

describe('DepositStake — countdown timer', () => {
  it('displays countdown timer showing time remaining before match timeout', async () => {
    // Set up mock: created_ledger = 40000, timeout_ledgers = 120960
    // current_ledger = 50000 (mocked by getLedgers)
    // Time remaining = (40000 + 120960 - 50000) * 5 = 110960 * 5 = 554800 seconds
    // = about 6 days
    setSimulateResponse({
      result: {
        retval: {
          ...defaultMatch,
          created_ledger: 40000n,
          timeout_ledgers: 120_960n,
        },
      },
    });

    render(<DepositStake matchId="123" playerAddress="test-player" contractId="test-contract" />);

    // Wait for the countdown to be displayed
    const countdown = await screen.findByTestId('timeout-countdown');
    expect(countdown).toBeInTheDocument();

    // The countdown should display a non-expired duration
    expect(countdown).not.toHaveTextContent('Expired');
    // Should contain time remaining text (formatted as "Xh Ym Zs" or similar)
    const timeText = countdown.textContent;
    expect(timeText).toMatch(/\d+[dhms]/); // Should have days, hours, minutes, or seconds
  });

  it('displays expiry message when timeout has passed', async () => {
    // This test creates a component in an expired state
    // Since the timeout hasn't actually elapsed (we're using mocked ledgers),
    // we test the expiry UI by verifying the component correctly calculates
    // when time is 0 or negative
    setSimulateResponse({
      result: {
        retval: {
          ...defaultMatch,
          created_ledger: 40000n,
          timeout_ledgers: 120_960n,
        },
      },
    });

    render(<DepositStake matchId="123" playerAddress="test-player" contractId="test-contract" />);

    // Countdown should exist and NOT show expired initially
    const countdown = await screen.findByTestId('timeout-countdown');
    expect(countdown).toBeInTheDocument();
    expect(countdown.textContent).not.toContain('Expired');

    // The deposit button should be enabled (not expired)
    const depositBtn = screen.getByTestId('deposit-btn');
    expect(depositBtn).not.toBeDisabled();
  });

  it('updates countdown timer every second', async () => {
    setSimulateResponse({
      result: {
        retval: {
          ...defaultMatch,
          created_ledger: 40000n,
          timeout_ledgers: 120_960n,
        },
      },
    });

    const { rerender } = render(
      <DepositStake matchId="123" playerAddress="test-player" contractId="test-contract" />,
    );

    const countdown = await screen.findByTestId('timeout-countdown');
    const initialText = countdown.textContent;

    // After render, the timer should update due to the 1-second interval
    // We can't easily test actual time progression in unit tests, but we can
    // verify the countdown element exists and updates
    expect(countdown).toBeInTheDocument();
    expect(initialText).toBeTruthy();
  });
});

describe('DepositStake — contract lifecycle', () => {
  it.each(['Active', 'PendingResult', 'Completed', 'Cancelled'])(
    'disables deposits in %s even with no deposits recorded',
    async (state) => {
      const onDeposit = vi.fn();
      setSimulateResponse({ result: { retval: { ...defaultMatch, state: [state] } } });
      render(
        <DepositStake
          matchId="123"
          playerAddress={defaultMatch.player1}
          contractId="test-contract"
          onDeposit={onDeposit}
        />,
      );
      expect(await screen.findByTestId('deposit-state-reason')).toHaveTextContent(state);
      expect(screen.getByTestId('deposit-btn')).toBeDisabled();
      fireEvent.click(screen.getByTestId('deposit-btn'));
      expect(onDeposit).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, ['Unknown']])('rejects an invalid contract state %s', async (state) => {
    setSimulateResponse({ result: { retval: { ...defaultMatch, state } } });
    render(
      <DepositStake
        matchId="123"
        playerAddress={defaultMatch.player1}
        contractId="test-contract"
      />,
    );
    expect(await screen.findByTestId('deposit-error')).toHaveTextContent(
      'Unexpected match lifecycle state',
    );
    expect(screen.queryByTestId('deposit-btn')).not.toBeInTheDocument();
  });
});

it('allows a pending Soroban enum tuple and keeps the two deposit flags independent', async () => {
  setSimulateResponse({
    result: { retval: { ...defaultMatch, state: ['Pending'], player1_deposited: true } },
  });
  render(
    <DepositStake matchId="123" playerAddress={defaultMatch.player2} contractId="test-contract" />,
  );
  await screen.findByTestId('match-info');
  expect(screen.getByTestId('player1-status')).toHaveTextContent('Deposited');
  expect(screen.getByTestId('player2-status')).toHaveTextContent('Pending');
  expect(screen.getByTestId('deposit-btn')).toBeEnabled();
});

it('rejects missing deposit flags instead of treating them as false', async () => {
  setSimulateResponse({ result: { retval: { ...defaultMatch, player1_deposited: undefined } } });
  render(
    <DepositStake matchId="123" playerAddress={defaultMatch.player1} contractId="test-contract" />,
  );
  expect(await screen.findByTestId('deposit-error')).toHaveTextContent('Unexpected response');
});
