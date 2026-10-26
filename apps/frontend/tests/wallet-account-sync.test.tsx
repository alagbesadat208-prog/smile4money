import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WalletProvider, useWalletContext } from '../src/providers/WalletProvider';
import { useWallet } from '../src/hooks/useWallet';
import { useTransactions } from '../src/hooks/useTransactions';
import { ClaimBurn } from '../src/components/claim-burn';
import { ToastProvider } from '../src/components/Toast';
import {
  setHistoryCacheEntry,
  getHistoryCacheEntry,
  invalidateHistoryCache,
} from '../src/pages/history-cache';

function WalletConsumer() {
  const { walletState, address, balance, network, isInstalled, connect, disconnect } =
    useWalletContext();
  return (
    <div>
      <span data-testid="wallet-address">{address ?? 'none'}</span>
      <span data-testid="wallet-state">{walletState}</span>
      <span data-testid="wallet-network">{network}</span>
      <span data-testid="wallet-balance">{balance ?? 'none'}</span>
      <span data-testid="wallet-installed">{String(isInstalled)}</span>
      <button type="button" data-testid="connect-btn" onClick={() => void connect()}>
        Connect
      </button>
      <button type="button" data-testid="disconnect-btn" onClick={disconnect}>
        Disconnect
      </button>
    </div>
  );
}

describe('Issue #1947 — Wallet Account Change Synchronization', () => {
  let mockFreighter: {
    isConnected: ReturnType<typeof vi.fn>;
    getPublicKey: ReturnType<typeof vi.fn>;
    getNetwork: ReturnType<typeof vi.fn>;
    signTransaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateHistoryCache();

    mockFreighter = {
      isConnected: vi.fn().mockResolvedValue({ isConnected: true }),
      getPublicKey: vi.fn().mockResolvedValue('GACCOUNT_A_1111'),
      getNetwork: vi.fn().mockResolvedValue({
        network: 'testnet',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }),
      signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: 'SIGNED_TX' }),
    };

    (window as { freighterApi?: unknown }).freighterApi = mockFreighter;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          balances: [{ asset_type: 'native', balance: '100.0' }],
        }),
      }),
    );
  });

  afterEach(() => {
    delete (window as { freighterApi?: unknown }).freighterApi;
    delete (window as { freighter?: unknown }).freighter;
    delete (window as { stellar?: unknown }).stellar;
    vi.unstubAllGlobals();
  });

  it('account-change events update the active account in WalletProvider', async () => {
    render(
      <WalletProvider>
        <WalletConsumer />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByTestId('connect-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('wallet-address')).toHaveTextContent('GACCOUNT_A_1111');
    });

    // Simulate account change in wallet extension to Account B
    mockFreighter.getPublicKey.mockResolvedValue('GACCOUNT_B_2222');

    await act(async () => {
      window.dispatchEvent(new Event('freighter:accountChanged'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('wallet-address')).toHaveTextContent('GACCOUNT_B_2222');
    });
  });

  it('account-scoped cached reads are invalidated when active account changes', async () => {
    // Populate cache for account A
    setHistoryCacheEntry('GACCOUNT_A_1111', {
      history: [],
      nextCursor: null,
      fetchedAt: Date.now(),
    });
    expect(getHistoryCacheEntry('GACCOUNT_A_1111')).toBeDefined();

    render(
      <WalletProvider>
        <WalletConsumer />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByTestId('connect-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('wallet-address')).toHaveTextContent('GACCOUNT_A_1111');
    });

    // Switch account to Account B
    mockFreighter.getPublicKey.mockResolvedValue('GACCOUNT_B_2222');

    await act(async () => {
      window.dispatchEvent(new Event('freighter:accountChanged'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('wallet-address')).toHaveTextContent('GACCOUNT_B_2222');
    });

    // Cache for Account A must have been invalidated
    expect(getHistoryCacheEntry('GACCOUNT_A_1111')).toBeUndefined();
  });

  it('an action prepared for Account A cannot be signed by Account B', async () => {
    // Action prepared with account A
    const { handleClaim } = useTransactions('GACCOUNT_A_1111', 'testnet');

    // Wallet switches to account B before signing
    mockFreighter.getPublicKey.mockResolvedValue('GACCOUNT_B_2222');

    await expect(handleClaim('10')).rejects.toThrow(
      /Active account changed from GACCOUNT_A_1111 to GACCOUNT_B_2222\. Please re-confirm transaction with active account\./i,
    );

    // Signing must be blocked
    expect(mockFreighter.signTransaction).not.toHaveBeenCalled();
  });

  it('signing after an account change requires fresh confirmation in ClaimBurn component', async () => {
    const onClaim = vi.fn().mockResolvedValue('hash-123');
    const onSimulate = vi.fn().mockResolvedValue({ minResourceFee: '100' });

    const { rerender } = render(
      <ToastProvider>
        <ClaimBurn
          walletState="connected"
          publicKey="GACCOUNT_A_1111"
          balance="500"
          onClaim={onClaim}
          onSimulateTransaction={onSimulate}
        />
      </ToastProvider>,
    );

    // Enter amount and trigger simulation to reach confirm overlay
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '10' } });
    fireEvent.submit(screen.getByTestId('claim-burn-form'));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-overlay')).toBeInTheDocument();
    });
    expect(screen.getByTestId('confirm-active-account')).toHaveTextContent(/GACCOU/i);

    // Now account switches to Account B while confirmation overlay was pending
    rerender(
      <ToastProvider>
        <ClaimBurn
          walletState="connected"
          publicKey="GACCOUNT_B_2222"
          balance="300"
          onClaim={onClaim}
          onSimulateTransaction={onSimulate}
        />
      </ToastProvider>,
    );

    // Old confirmation overlay must be dismissed and reset
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-overlay')).not.toBeInTheDocument();
    });

    // Error message indicates account change requiring fresh confirmation
    expect(screen.getByTestId('claim-burn-status')).toHaveTextContent(
      /Active wallet account changed/i,
    );

    // onClaim was NOT invoked with stale confirmation
    expect(onClaim).not.toHaveBeenCalled();
  });

  it('disconnect and reconnect events leave the provider in a consistent state', async () => {
    render(
      <WalletProvider>
        <WalletConsumer />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByTestId('connect-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('wallet-address')).toHaveTextContent('GACCOUNT_A_1111');
      expect(screen.getByTestId('wallet-state')).toHaveTextContent('connected');
    });

    // Simulate disconnect in wallet
    mockFreighter.isConnected.mockResolvedValue({ isConnected: false });

    await act(async () => {
      window.dispatchEvent(new Event('freighter:accountChanged'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('wallet-address')).toHaveTextContent('none');
      expect(screen.getByTestId('wallet-state')).toHaveTextContent('disconnected');
    });

    // Simulate reconnect
    mockFreighter.isConnected.mockResolvedValue({ isConnected: true });
    mockFreighter.getPublicKey.mockResolvedValue('GACCOUNT_RECONNECTED');

    fireEvent.click(screen.getByTestId('connect-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('wallet-address')).toHaveTextContent('GACCOUNT_RECONNECTED');
      expect(screen.getByTestId('wallet-state')).toHaveTextContent('connected');
    });
  });

  it('event listeners are cleaned up correctly when component unmounts', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = render(
      <WalletProvider>
        <WalletConsumer />
      </WalletProvider>,
    );

    expect(addSpy).toHaveBeenCalledWith('freighter:accountChanged', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('freighter:networkChanged', expect.any(Function));

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('freighter:accountChanged', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('freighter:networkChanged', expect.any(Function));
  });
});
