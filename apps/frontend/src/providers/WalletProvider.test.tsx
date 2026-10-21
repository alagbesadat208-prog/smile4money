import { Networks } from '@stellar/stellar-sdk';
import React from 'react';
import { render, screen, renderHook, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WalletProvider, useWalletContext } from './WalletProvider';

function WalletConsumer() {
  const { walletState, address, balance, network, isInstalled, connect } = useWalletContext();
  return (
    <div>
      <span data-testid="wallet-context-state">{walletState}</span>
      <span data-testid="wallet-context-address">{address ?? 'none'}</span>
      <span data-testid="wallet-context-balance">{balance ?? 'none'}</span>
      <span data-testid="wallet-context-network">{network}</span>
      <span data-testid="wallet-context-installed">{String(isInstalled)}</span>
      <button type="button" data-testid="wallet-connect-btn" onClick={() => void connect()}>
        Connect
      </button>
    </div>
  );
}

const accountResponse = {
  balances: [{ asset_type: 'native', balance: '123.4' }],
};

function installFreighter(networkName: 'testnet' | 'mainnet') {
  const networkPassphrase = networkName === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;
  (window as { freighterApi?: unknown }).freighterApi = {
    isConnected: async () => ({ isConnected: true }),
    getPublicKey: async () => 'GBTEST123',
    getNetwork: async () => ({ network: networkName, networkPassphrase }),
    signTransaction: async (xdr: string) => ({ signedTxXdr: xdr }),
  };
}

describe('WalletProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as { freighterApi?: unknown }).freighterApi;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => accountResponse,
      }),
    );
  });

  afterEach(() => {
    delete (window as { freighterApi?: unknown }).freighterApi;
    vi.unstubAllGlobals();
  });

  it('provides wallet state to children', () => {
    render(
      <WalletProvider>
        <WalletConsumer />
      </WalletProvider>,
    );
    expect(screen.getByTestId('wallet-context-state')).toHaveTextContent('notInstalled');
    expect(screen.getByTestId('wallet-context-address')).toHaveTextContent('none');
    expect(screen.getByTestId('wallet-context-installed')).toHaveTextContent('false');
  });

  it('surfaces the connected state and address after connecting', async () => {
    installFreighter('testnet');
    render(
      <WalletProvider>
        <WalletConsumer />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByTestId('wallet-connect-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('wallet-context-state')).toHaveTextContent('connected'),
    );
    expect(screen.getByTestId('wallet-context-address')).toHaveTextContent('GBTEST123');
    expect(screen.getByTestId('wallet-context-network')).toHaveTextContent('testnet');
    expect(screen.getByTestId('wallet-context-balance')).toHaveTextContent('123.4');
  });

  it('normalizes a mainnet connection to wrongNetwork', async () => {
    installFreighter('mainnet');
    render(
      <WalletProvider>
        <WalletConsumer />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByTestId('wallet-connect-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('wallet-context-state')).toHaveTextContent('wrongNetwork'),
    );
    expect(screen.getByTestId('wallet-context-address')).toHaveTextContent('GBTEST123');
  });

  it('blocks a connected wallet with no verifiable network', async () => {
    installFreighter('testnet');
    delete window.freighterApi!.getNetwork;
    render(
      <WalletProvider>
        <WalletConsumer />
      </WalletProvider>,
    );
    fireEvent.click(screen.getByTestId('wallet-connect-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('wallet-context-state')).toHaveTextContent('wrongNetwork'),
    );
  });

  it('exposes connect and disconnect actions', async () => {
    const { result } = renderHook(() => useWalletContext(), {
      wrapper: ({ children }) => <WalletProvider>{children}</WalletProvider>,
    });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.walletState).toBe('notInstalled');

    act(() => {
      result.current.disconnect();
    });
    expect(result.current.address).toBeNull();
    expect(result.current.balance).toBeNull();
  });

  it('throws when used outside the provider', () => {
    expect(() => renderHook(() => useWalletContext())).toThrow(
      /useWalletContext must be used within a WalletProvider/,
    );
  });
});
