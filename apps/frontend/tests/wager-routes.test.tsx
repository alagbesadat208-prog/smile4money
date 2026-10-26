import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
vi.mock('../src/components/CreateMatch', () => ({
  CreateMatch: () => <div data-testid="create-workflow" />,
}));
vi.mock('../src/components/DepositStake', () => ({
  DepositStake: ({ matchId }: { matchId: string }) => (
    <div data-testid="deposit-workflow">{matchId}</div>
  ),
}));
vi.mock('../src/components/MatchStatus', () => ({
  MatchStatus: ({ matchId }: { matchId: string }) => (
    <div data-testid="details-workflow">{matchId}</div>
  ),
}));
vi.mock('../src/pages/History', () => ({ History: () => <h1>Transaction history</h1> }));
afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});
describe('wager navigation and refresh', () => {
  it.each([
    ['/create-match', 'create-workflow', ''],
    ['/matches/42/deposit', 'deposit-workflow', '42'],
    ['/matches/42', 'details-workflow', '42'],
  ])('resolves a direct link and a fresh mount of %s', (path, testId, value) => {
    window.history.replaceState({}, '', path);
    for (let refresh = 0; refresh < 2; refresh++) {
      render(<App />);
      expect(screen.getByTestId(testId)).toHaveTextContent(value);
      expect(screen.getAllByTestId('application-shell')).toHaveLength(1);
      cleanup();
    }
  });
  it('exposes primary links and a history route', () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const text of ['Create match', 'Deposit', 'Match details', 'History'])
      expect(nav).toHaveTextContent(text);
    fireEvent.click(screen.getByRole('link', { name: 'History' }));
    expect(window.location.pathname).toBe('/history');
    expect(screen.getByRole('heading', { name: 'Transaction history' })).toBeInTheDocument();
  });
  it('looks up a deposit by ID and rejects invalid direct IDs', () => {
    window.history.replaceState({}, '', '/deposit');
    render(<App />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Match ID' }), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find match' }));
    expect(screen.getByTestId('deposit-workflow')).toHaveTextContent('7');
    cleanup();
    window.history.replaceState({}, '', '/matches/not-a-number');
    render(<App />);
    expect(screen.getByText('Invalid match ID')).toBeInTheDocument();
  });
});
