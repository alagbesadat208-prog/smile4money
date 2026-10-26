import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MatchStatus, type MatchData } from '../src/components/MatchStatus';

describe('Issue #1950 — Match Status Lifecycle States', () => {
  const baseMatch: MatchData = {
    id: '42',
    state: 'Active',
    player1: 'GPLAYER1',
    player2: 'GPLAYER2',
    stakeAmount: '50',
    token: 'xlm',
    platform: 'lichess',
    gameId: 'game-42',
  };

  it('1. shows distinct in-progress state when chess game is still being played', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      ...baseMatch,
      state: 'Active',
      gameStatus: 'in_progress',
    });

    render(<MatchStatus matchId="42" onFetchMatch={onFetchMatch} />);

    await waitFor(() => {
      expect(screen.getByTestId('state-game-in-progress')).toBeInTheDocument();
    });

    const statusEl = screen.getByTestId('state-game-in-progress');
    expect(statusEl).toHaveTextContent(/Game in Progress/i);
    expect(statusEl).toHaveTextContent(/Awaiting completion before oracle verification begins/i);
    // Uses accessible status role
    expect(statusEl).toHaveAttribute('role', 'status');

    // Not conflated with failure or waiting for settlement
    expect(screen.queryByTestId('state-failed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('state-pending-result')).not.toBeInTheDocument();
  });

  it('1b. supports GameInProgress as direct backend enum state', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      ...baseMatch,
      state: 'GameInProgress',
    });

    render(<MatchStatus matchId="42" onFetchMatch={onFetchMatch} />);

    await waitFor(() => {
      expect(screen.getByTestId('state-game-in-progress')).toBeInTheDocument();
    });
    expect(screen.getByText('Game in Progress')).toBeInTheDocument();
  });

  it('2. distinguishes oracle / result verification in progress', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      ...baseMatch,
      state: 'Verifying',
      verificationStatus: 'in_progress',
    });

    render(<MatchStatus matchId="42" onFetchMatch={onFetchMatch} />);

    await waitFor(() => {
      expect(screen.getByTestId('state-verifying')).toBeInTheDocument();
    });

    const verifyingEl = screen.getByTestId('state-verifying');
    expect(verifyingEl).toHaveTextContent(/Verification in Progress/i);
    expect(verifyingEl).toHaveTextContent(/Oracle verification is currently in progress/i);
    expect(verifyingEl).toHaveAttribute('role', 'status');

    // Distinct from game playing
    expect(screen.queryByTestId('state-game-in-progress')).not.toBeInTheDocument();
  });

  it('3. distinguishes result verified but settlement pending with countdown', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      ...baseMatch,
      state: 'PendingResult',
      pendingResultLedger: 1000,
      currentLedger: 500,
      winner: 'Player1',
    });

    render(<MatchStatus matchId="42" onFetchMatch={onFetchMatch} />);

    await waitFor(() => {
      expect(screen.getByTestId('state-pending-result')).toBeInTheDocument();
    });

    const pendingEl = screen.getByTestId('state-pending-result');
    expect(pendingEl).toHaveTextContent(/Result Pending/i);
    expect(pendingEl).toHaveTextContent(/Dispute window is open/i);
    expect(screen.getByTestId('dispute-countdown')).toBeInTheDocument();
  });

  it('4. distinguishes completed and settled state', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      ...baseMatch,
      state: 'Completed',
      winner: 'Player1',
    });

    render(<MatchStatus matchId="42" onFetchMatch={onFetchMatch} />);

    await waitFor(() => {
      expect(screen.getByTestId('state-completed')).toBeInTheDocument();
    });

    const completedEl = screen.getByTestId('state-completed');
    expect(completedEl).toHaveTextContent(/Completed/i);
    expect(completedEl).toHaveTextContent(/Winner: Player 1/i);
  });

  it('5. distinguishes verification failure with accessible alert role', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      ...baseMatch,
      state: 'VerificationFailed',
    });

    render(<MatchStatus matchId="42" onFetchMatch={onFetchMatch} />);

    await waitFor(() => {
      expect(screen.getByTestId('state-failed')).toBeInTheDocument();
    });

    const failedEl = screen.getByTestId('state-failed');
    expect(failedEl).toHaveTextContent(/Verification Failed/i);
    expect(failedEl).toHaveAttribute('role', 'alert');
  });

  it('5b. distinguishes settlement failure with accessible alert role', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      ...baseMatch,
      state: 'SettlementFailed',
    });

    render(<MatchStatus matchId="42" onFetchMatch={onFetchMatch} />);

    await waitFor(() => {
      expect(screen.getByTestId('state-failed')).toBeInTheDocument();
    });

    const failedEl = screen.getByTestId('state-failed');
    expect(failedEl).toHaveTextContent(/Settlement Failed/i);
    expect(failedEl).toHaveAttribute('role', 'alert');
  });

  it('renders a safe fallback label for unknown backend statuses without crashing', async () => {
    const onFetchMatch = vi.fn().mockResolvedValue({
      ...baseMatch,
      state: 'NonExistentState',
    });

    render(<MatchStatus matchId="42" onFetchMatch={onFetchMatch} />);

    await waitFor(() => {
      expect(screen.getByTestId('state-unknown')).toBeInTheDocument();
    });

    const unknownEl = screen.getByTestId('state-unknown');
    expect(unknownEl).toHaveTextContent(/Status: NonExistentState/i);
    expect(unknownEl).toHaveAttribute('role', 'status');
  });
});
