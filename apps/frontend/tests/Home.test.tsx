import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from '../src/pages/Home';
const { wallet, connect } = vi.hoisted(() => {
  const connect = vi.fn();
  return {
    connect,
    wallet: {
      walletState: 'disconnected',
      network: 'unknown',
      address: null,
      connect,
      disconnect: vi.fn(),
      error: null,
    },
  };
});
vi.mock('../src/providers/WalletProvider', () => ({ useWalletContext: () => wallet }));
vi.mock('../src/providers/ThemeProvider', () => ({
  useThemeContext: () => ({ theme: 'light', toggle: vi.fn() }),
}));
vi.mock('../src/deployment', async (original) => {
  const actual = await original<typeof import('../src/deployment')>();
  return {
    ...actual,
    setupState: (status: string, network: import('../src/types').Network) =>
      actual.setupState(status, network, true, 'testnet'),
  };
});
vi.mock('../src/pages/History', () => ({ History: () => <div data-testid="history-page" /> }));
describe('Home setup', () => {
  beforeEach(() => {
    wallet.walletState = 'disconnected';
    wallet.network = 'unknown';
    vi.clearAllMocks();
  });
  it('offers connection without unsupported financial controls', () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(connect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /claim|burn/i })).not.toBeInTheDocument();
  });
  it('explains how to select the supported network', () => {
    wallet.walletState = 'connected';
    wallet.network = 'mainnet';
    render(<Home />);
    expect(screen.getByTestId('setup-unsupported')).toHaveTextContent('select testnet');
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect wallet' }));
    expect(connect).toHaveBeenCalledOnce();
  });
  it('shows readiness on the deployment network', () => {
    wallet.walletState = 'connected';
    wallet.network = 'testnet';
    render(<Home />);
    expect(screen.getByTestId('setup-ready')).toHaveTextContent('Wallet ready');
    expect(screen.queryByRole('button', { name: /claim|burn/i })).not.toBeInTheDocument();
  });
});
