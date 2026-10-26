import { useState, useCallback, useEffect, useRef } from 'react';
import type { WalletStatus, Network } from '../types';
import { isNetworkMatch } from './useNetworkStatus';
import { invalidateHistoryCache } from '../pages/history-cache';

declare global {
  interface Window {
    freighterApi?: {
      isConnected: () => Promise<{ isConnected: boolean }>;
      getPublicKey: () => Promise<string>;
      signTransaction: (
        xdr: string,
        opts?: { networkPassphrase?: string },
      ) => Promise<{ signedTxXdr: string }>;
      getNetwork?: () => Promise<{ network: string; networkPassphrase: string }>;
    };
    /** Freighter injects this event emitter for wallet state change notifications. */
    freighter?: {
      on?: (event: string, handler: () => void) => void;
      off?: (event: string, handler: () => void) => void;
    };
  }
}

const HORIZON_URLS: Record<string, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
  unknown: 'https://horizon-testnet.stellar.org',
};

interface StellarWallet {
  status: WalletStatus;
  address: string | null;
  error: string | null;
  balance: string | null;
  network: Network;
  isInstalled: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
}

function detectNetwork(networkPassphrase?: string): Network {
  if (!networkPassphrase) return 'unknown';
  if (networkPassphrase.includes('testnet') || networkPassphrase.includes('Test SDF Network')) return 'testnet';
  if (networkPassphrase.includes('pubnet') || networkPassphrase.includes('Public Global Stellar Network')) return 'mainnet';
  return 'unknown';
}

async function fetchHorizonBalance(
  address: string,
  network: Network,
  signal?: AbortSignal,
): Promise<string> {
  const horizon = HORIZON_URLS[network] || HORIZON_URLS.unknown;
  const res = await fetch(`${horizon}/accounts/${address}`, { signal });
  if (!res.ok) throw new Error('Failed to fetch balance');
  const data = await res.json();
  const native = data.balances.find((b: { asset_type: string }) => b.asset_type === 'native');
  return native ? native.balance : '0';
}

export function useStellarWallet(): StellarWallet {
  const [status, setStatus] = useState<WalletStatus>('checking');
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [network, setNetwork] = useState<Network>('unknown');

  const freighter = typeof window !== 'undefined' ? window.freighterApi : undefined;
  const isInstalled = !!freighter;

  // Ref to abort in-flight balance fetches on unmount or re-fetch.
  const balanceAbortRef = useRef<AbortController | null>(null);
  const prevAddressRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      setStatus('disconnected');
      return;
    }
    setStatus(window.freighterApi ? 'disconnected' : 'notInstalled');
  }, []);

  // Subscribe to Freighter wallet change events so that if the user disconnects
  // or switches accounts/networks from the extension, the app state updates immediately.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleWalletChange = async () => {
      const api = window.freighterApi;
      if (!api) {
        // Extension was removed
        const oldAddr = prevAddressRef.current;
        if (oldAddr) invalidateHistoryCache(oldAddr);
        prevAddressRef.current = null;
        setAddress(null);
        setBalance(null);
        setNetwork('unknown');
        setStatus('notInstalled');
        return;
      }

      try {
        const { isConnected } = await api.isConnected();
        if (!isConnected) {
          // User disconnected from the extension
          const oldAddr = prevAddressRef.current;
          if (oldAddr) invalidateHistoryCache(oldAddr);
          prevAddressRef.current = null;
          setAddress(null);
          setBalance(null);
          setNetwork('unknown');
          setStatus('disconnected');
          return;
        }

        // Account or network may have changed — refresh all state
        const publicKey = await api.getPublicKey();
        const oldAddr = prevAddressRef.current;

        // Invalidate cached reads for previous account when active account changes
        if (oldAddr && oldAddr !== publicKey) {
          invalidateHistoryCache(oldAddr);
        }
        prevAddressRef.current = publicKey;
        setAddress(publicKey);

        let detectedNetwork: Network = 'unknown';
        let rawPassphrase = '';
        if (api.getNetwork) {
          const net = await api.getNetwork();
          rawPassphrase = net.networkPassphrase;
          detectedNetwork = detectNetwork(rawPassphrase);
          setNetwork(detectedNetwork);
        }

        const isMatch = isNetworkMatch(
          rawPassphrase
            ? { network: detectedNetwork, networkPassphrase: rawPassphrase }
            : detectedNetwork,
        );

        if (detectedNetwork !== 'unknown' && !isMatch) {
          setStatus('wrongNetwork');
        } else {
          setStatus('connected');
        }

        // Abort any previous in-flight balance fetch before starting a new one.
        balanceAbortRef.current?.abort();
        const controller = new AbortController();
        balanceAbortRef.current = controller;
        fetchHorizonBalance(publicKey, detectedNetwork, controller.signal)
          .then((bal) => setBalance(bal))
          .catch(() => setBalance(null));
      } catch {
        const oldAddr = prevAddressRef.current;
        if (oldAddr) invalidateHistoryCache(oldAddr);
        prevAddressRef.current = null;
        setAddress(null);
        setBalance(null);
        setNetwork('unknown');
        setStatus('disconnected');
      }
    };

    window.addEventListener('freighter:accountChanged', handleWalletChange);
    window.addEventListener('freighter:networkChanged', handleWalletChange);

    // Also register on window.freighter adapter emitter if available
    if (window.freighter?.on) {
      window.freighter.on('accountChanged', handleWalletChange);
      window.freighter.on('networkChanged', handleWalletChange);
    }

    return () => {
      window.removeEventListener('freighter:accountChanged', handleWalletChange);
      window.removeEventListener('freighter:networkChanged', handleWalletChange);
      if (window.freighter?.off) {
        window.freighter.off('accountChanged', handleWalletChange);
        window.freighter.off('networkChanged', handleWalletChange);
      }
      balanceAbortRef.current?.abort();
    };
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!address) return;
    try {
      balanceAbortRef.current?.abort();
      const controller = new AbortController();
      balanceAbortRef.current = controller;
      const bal = await fetchHorizonBalance(address, network, controller.signal);
      setBalance(bal);
    } catch {
      setBalance(null);
    }
  }, [address, network]);

  const connect = useCallback(async () => {
    if (!freighter) {
      setStatus('notInstalled');
      return;
    }

    setStatus('connecting');
    setError(null);

    try {
      const { isConnected } = await freighter.isConnected();
      if (!isConnected) {
        setStatus('disconnected');
        return;
      }

      const publicKey = await freighter.getPublicKey();
      const oldAddr = prevAddressRef.current;
      if (oldAddr && oldAddr !== publicKey) {
        invalidateHistoryCache(oldAddr);
      }
      prevAddressRef.current = publicKey;
      setAddress(publicKey);

      let detectedNetwork: Network = 'unknown';
      let rawPassphrase = '';
      if (freighter.getNetwork) {
        const net = await freighter.getNetwork();
        rawPassphrase = net.networkPassphrase;
        detectedNetwork = detectNetwork(rawPassphrase);
        setNetwork(detectedNetwork);
      }

      const isMatch = isNetworkMatch(
        rawPassphrase
          ? { network: detectedNetwork, networkPassphrase: rawPassphrase }
          : detectedNetwork,
      );

      if (detectedNetwork !== 'unknown' && !isMatch) {
        setStatus('wrongNetwork');
      } else {
        setStatus('connected');
      }

      // Abort any previous in-flight balance fetch before starting a new one.
      balanceAbortRef.current?.abort();
      const controller = new AbortController();
      balanceAbortRef.current = controller;
      fetchHorizonBalance(publicKey, detectedNetwork, controller.signal)
        .then((bal) => setBalance(bal))
        .catch(() => setBalance(null));
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to connect to Freighter wallet');
    }
  }, [freighter]);

  const disconnect = useCallback(() => {
    const oldAddr = prevAddressRef.current || address;
    if (oldAddr) {
      invalidateHistoryCache(oldAddr);
    }
    prevAddressRef.current = null;
    balanceAbortRef.current?.abort();
    setAddress(null);
    setBalance(null);
    setStatus(freighter ? 'disconnected' : 'notInstalled');
    setError(null);
    setNetwork('unknown');
  }, [address, freighter]);

  return {
    status,
    address,
    error,
    balance,
    network,
    isInstalled,
    connect,
    disconnect,
    refreshBalance,
  };
}
