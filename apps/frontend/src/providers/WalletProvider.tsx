import { createContext, useContext, type ReactNode, type JSX } from 'react';
import { useStellarWallet } from '../hooks/useStellarWallet';
import { isNetworkMatch } from '../hooks/useNetworkStatus';
import type { Network, WalletStatus } from '../types';

interface WalletContextValue {
  status: WalletStatus;
  /** Normalized status: a connected wallet on the wrong network reports `wrongNetwork`. */
  walletState: WalletStatus;
  address: string | null;
  error: string | null;
  balance: string | null;
  network: Network;
  isInstalled: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

/**
 * Owns all wallet state (Freighter connection, network, balance) so components
 * can consume it via `useWalletContext` instead of duplicating the hook.
 */
export function WalletProvider({ children }: { children: ReactNode }): JSX.Element {
  const wallet = useStellarWallet();

  const walletState: WalletStatus =
    wallet.status === 'connected' && !isNetworkMatch(wallet.network)
      ? 'wrongNetwork'
      : wallet.status;

  const value: WalletContextValue = { ...wallet, walletState };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWalletContext(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWalletContext must be used within a WalletProvider');
  }
  return context;
}