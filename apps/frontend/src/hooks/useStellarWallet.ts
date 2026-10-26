import { useState, useCallback, useEffect, useRef } from 'react';
import type { WalletStatus, Network } from '../types';
import { configForWallet } from '../config/network';

const EXPECTED_NETWORK =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { VITE_STELLAR_NETWORK?: string } }).env?.VITE_STELLAR_NETWORK) ||
  'testnet';

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
  if (networkPassphrase.includes('testnet')) return 'testnet';
  if (networkPassphrase.includes('pubnet')) return 'mainnet';
  return 'unknown';
}

async function fetchHorizonBalance(
  address: string,
  network: Network,
  signal?: AbortSignal,
): Promise<string> {
  const horizon = configForWallet(network).horizonUrl;
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

    // Freighter dispatches a custom DOM event named "freighter:accountChanged" when
    // the user changes accounts, and "freighter:networkChanged" when the network changes.
    // Both cases should trigger a re-check: if the wallet is no longer connected we
    // transition to disconnected; if the account changed we reload the address.
    const handleWalletChange = async () => {
      const api = window.freighterApi;
      if (!api) {
        // Extension was removed
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
          setAddress(null);
          setBalance(null);
          setNetwork('unknown');
          setStatus('disconnected');
          return;
        }

        // Account or network may have changed — refresh all state
        const publicKey = await api.getPublicKey();
        setAddress(publicKey);

        let detectedNetwork: Network = 'unknown';
        if (api.getNetwork) {
          const net = await api.getNetwork();
          detectedNetwork = detectNetwork(net.networkPassphrase);
          setNetwork(detectedNetwork);
        }

        if (detectedNetwork !== 'unknown' && detectedNetwork !== EXPECTED_NETWORK) {
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
        setAddress(null);
        setBalance(null);
        setNetwork('unknown');
        setStatus('disconnected');
      }
    };

    window.addEventListener('freighter:accountChanged', handleWalletChange);
    window.addEventListener('freighter:networkChanged', handleWalletChange);

    return () => {
      window.removeEventListener('freighter:accountChanged', handleWalletChange);
      window.removeEventListener('freighter:networkChanged', handleWalletChange);
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
      setAddress(publicKey);

      let detectedNetwork: Network = 'unknown';
      if (freighter.getNetwork) {
        const net = await freighter.getNetwork();
        detectedNetwork = detectNetwork(net.networkPassphrase);
        setNetwork(detectedNetwork);
      }

      if (detectedNetwork !== 'unknown' && detectedNetwork !== EXPECTED_NETWORK) {
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
    setAddress(null);
    setBalance(null);
    setStatus(freighter ? 'disconnected' : 'notInstalled');
    setError(null);
    setNetwork('unknown');
  }, [freighter]);

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
