/**
 * Snapshot tests for primary rendered states of key UI components.
 *
 * These catch unintended visual / JSX regressions caused by style or
 * structural refactors that behavioural assertions alone would miss.
 *
 * Run `vitest --update-snapshots` to regenerate baselines after an
 * intentional UI change.
 */

import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MatchStatus } from '../src/components/MatchStatus';
import { CreateMatch } from '../src/components/CreateMatch';
import { ClaimBurn } from '../src/components/claim-burn';
import { ToastProvider } from '../src/components/Toast';

// ── Shared mocks ─────────────────────────────────────────────────────────────

vi.mock('@stellar/stellar-sdk', () => ({
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  },
  rpc: {
    Server: vi.fn().mockImplementation(() => ({
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
      pollTransaction: vi.fn(),
    })),
    Api: {
      GetTransactionStatus: {
        SUCCESS: 'SUCCESS',
        NOT_FOUND: 'NOT_FOUND',
        FAILED: 'FAILED',
      },
    },
  },
}));

const VALID_ADDRESS = 'GAUXUJLYWYXK7UE22KXN5WJTP2MNOWVL4ZRDBJQ43WZB5HJP22JSYTRR';

// ── MatchStatus ───────────────────────────────────────────────────────────────

describe('MatchStatus — snapshots', () => {
  it('matches snapshot: no match ID (empty prompt)', () => {
    const { container } = render(<MatchStatus matchId="" />);
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: loading state (match ID provided, no fetch override)', () => {
    const { container } = render(<MatchStatus matchId="123" />);
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: pending state', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      id: '1',
      state: 'Pending',
      player1: 'GPLAYER1ABC',
      player2: 'GPLAYER2XYZ',
      stakeAmount: '100',
      token: 'xlm',
      platform: 'lichess',
      gameId: 'game-abc',
    });

    const { container, findByTestId } = render(
      <MatchStatus matchId="1" onFetchMatch={onFetchMatch} />,
    );
    await findByTestId('state-pending');
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: active state', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      id: '2',
      state: 'Active',
      player1: 'GPLAYER1ABC',
      player2: 'GPLAYER2XYZ',
      stakeAmount: '200',
      token: 'xlm',
      platform: 'lichess',
      gameId: 'game-def',
    });

    const { container, findByTestId } = render(
      <MatchStatus matchId="2" onFetchMatch={onFetchMatch} />,
    );
    await findByTestId('state-active');
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: completed state with winner', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      id: '3',
      state: 'Completed',
      player1: 'GPLAYER1ABC',
      player2: 'GPLAYER2XYZ',
      stakeAmount: '150',
      token: 'xlm',
      platform: 'lichess',
      gameId: 'game-ghi',
      winner: 'Player1',
    });

    const { container, findByTestId } = render(
      <MatchStatus matchId="3" onFetchMatch={onFetchMatch} />,
    );
    await findByTestId('state-completed');
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: cancelled state', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      id: '4',
      state: 'Cancelled',
      player1: 'GPLAYER1ABC',
      player2: 'GPLAYER2XYZ',
      stakeAmount: '50',
      token: 'xlm',
      platform: 'lichess',
      gameId: 'game-jkl',
    });

    const { container, findByTestId } = render(
      <MatchStatus matchId="4" onFetchMatch={onFetchMatch} />,
    );
    await findByTestId('state-cancelled');
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: match not found', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue(null);

    const { container, findByTestId } = render(
      <MatchStatus matchId="invalid" onFetchMatch={onFetchMatch} />,
    );
    await findByTestId('match-not-found');
    expect(container).toMatchSnapshot();
  });
});

// ── CreateMatch ───────────────────────────────────────────────────────────────

describe('CreateMatch — snapshots', () => {
  it('matches snapshot: default state (XLM / Lichess)', () => {
    const { container } = render(
      <CreateMatch contractId="test-contract" player1Address={VALID_ADDRESS} />,
    );
    expect(container).toMatchSnapshot();
  });

  it('hides USDC when no deployment is configured for the network', () => {
    const { queryByTestId } = render(
      <CreateMatch contractId="test-contract" player1Address={VALID_ADDRESS} />,
    );
    expect(queryByTestId('toggle-usdc')).not.toBeInTheDocument();
  });

  it('matches snapshot: Chess.com platform selected', () => {
    const { container, getByTestId } = render(
      <CreateMatch contractId="test-contract" player1Address={VALID_ADDRESS} />,
    );
    getByTestId('platform-chesscom').click();
    expect(container).toMatchSnapshot();
  });
});

// ── ClaimBurn ────────────────────────────────────────────────────────────────

function renderClaimBurn(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe('ClaimBurn — snapshots', () => {
  it('matches snapshot: checking/connecting state', () => {
    const { container } = renderClaimBurn(<ClaimBurn walletState="checking" />);
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: disconnected state', () => {
    const { container } = renderClaimBurn(<ClaimBurn walletState="disconnected" />);
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: connecting state', () => {
    const { container } = renderClaimBurn(<ClaimBurn walletState="connecting" />);
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: not installed state', () => {
    const { container } = renderClaimBurn(<ClaimBurn walletState="notInstalled" />);
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: wrong network state', () => {
    const { container } = renderClaimBurn(
      <ClaimBurn walletState="wrongNetwork" expectedNetwork="testnet" />,
    );
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: connected state (claim mode, empty amount)', () => {
    const { container } = renderClaimBurn(<ClaimBurn walletState="connected" />);
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: connected state with publicKey and balance', () => {
    const { container } = renderClaimBurn(
      <ClaimBurn walletState="connected" publicKey="GABCDEF1234567890XYZ" balance="100.5" />,
    );
    expect(container).toMatchSnapshot();
  });

  it('matches snapshot: connected state in burn mode', () => {
    const { container, getByTestId } = renderClaimBurn(<ClaimBurn walletState="connected" />);
    getByTestId('toggle-burn').click();
    expect(container).toMatchSnapshot();
  });
});
