import { useState, useEffect, useCallback, useRef } from 'react';
import { getExpectedNetwork, isNetworkMatch } from './useNetworkStatus';
import { invalidateHistoryCache } from '../pages/history-cache';

export type WalletState =
  | 'checking'
  | 'notInstalled'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'wrongNetwork';

declare global {
  interface Window {
    stellar?: {
      isConnected: () => Promise<{ isConnected: boolean }>;
      getPublicKey: () => Promise<string>;
      getNetwork: () => Promise<{ network: string; networkPassphrase: string }>;
      setAllowed: () => Promise<{ error?: { code: number; message: string } }>;
    };
    freighter?: {
      on?: (event: string, handler: () => void) => void;
      off?: (event: string, handler: () => void) => void;
    };
  }
  interface ImportMeta {
    env: {
      VITE_STELLAR_NETWORK?: string;
      DEV?: boolean;
      MODE?: string;
      PROD?: boolean;
      [key: string]: unknown;
    };
  }
}

/** localStorage key used to persist the user's connection preference. */
const WALLET_CONNECTED_KEY = 'wallet_connected';

export function useWallet() {
  const [state, setState] = useState<WalletState>('checking');
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expectedNetwork = getExpectedNetwork();
  const prevPublicKeyRef = useRef<string | null>(null);

  const checkConnection = useCallback(async () => {
    if (!window.stellar) {
      setState('notInstalled');
      return;
    }

    try {
      const { isConnected } = await window.stellar.isConnected();
      if (!isConnected) {
        const oldKey = prevPublicKeyRef.current;
        if (oldKey) invalidateHistoryCache(oldKey);
        prevPublicKeyRef.current = null;
        setPublicKey(null);
        setNetwork(null);
        setState('disconnected');
        return;
      }

      const pk = await window.stellar.getPublicKey();
      const net = await window.stellar.getNetwork();

      const oldKey = prevPublicKeyRef.current;
      if (oldKey && oldKey !== pk) {
        invalidateHistoryCache(oldKey);
      }
      prevPublicKeyRef.current = pk;

      setPublicKey(pk);
      setNetwork(net.network);

      const isMatch = isNetworkMatch(net);
      if (!isMatch) {
        setState('wrongNetwork');
      } else {
        setState('connected');
      }
    } catch {
      const oldKey = prevPublicKeyRef.current;
      if (oldKey) invalidateHistoryCache(oldKey);
      prevPublicKeyRef.current = null;
      setPublicKey(null);
      setNetwork(null);
      setState('disconnected');
    }
  }, []);

  // Listen to account and network change events from the wallet extension
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleWalletChange = async () => {
      await checkConnection();
    };

    window.addEventListener('freighter:accountChanged', handleWalletChange);
    window.addEventListener('freighter:networkChanged', handleWalletChange);

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
    };
  }, [checkConnection]);

  // On mount: if the user previously connected, attempt silent auto-reconnect.
  useEffect(() => {
    const stored = localStorage.getItem(WALLET_CONNECTED_KEY);
    if (stored === 'true') {
      checkConnection();
    } else {
      if (!window.stellar) {
        setState('notInstalled');
      } else {
        setState('disconnected');
      }
    }
  }, [checkConnection]);

  const connect = useCallback(async () => {
    if (!window.stellar) {
      setState('notInstalled');
      return;
    }

    setState('connecting');
    setError(null);

    try {
      const { error: accessError } = await window.stellar.setAllowed();
      if (accessError) {
        setState('disconnected');
        setError(accessError.message);
        return;
      }

      const pk = await window.stellar.getPublicKey();
      const net = await window.stellar.getNetwork();

      const oldKey = prevPublicKeyRef.current;
      if (oldKey && oldKey !== pk) {
        invalidateHistoryCache(oldKey);
      }
      prevPublicKeyRef.current = pk;

      setPublicKey(pk);
      setNetwork(net.network);

      const isMatch = isNetworkMatch(net);
      if (!isMatch) {
        setState('wrongNetwork');
        setError(`Wrong network: expected ${expectedNetwork}, got ${net.network}`);
        localStorage.setItem(WALLET_CONNECTED_KEY, 'true');
      } else {
        setState('connected');
        localStorage.setItem(WALLET_CONNECTED_KEY, 'true');
      }
    } catch (err) {
      setState('disconnected');
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    }
  }, [expectedNetwork]);

  const switchNetwork = useCallback(async () => {
    setError(null);
    const net = await window.stellar?.getNetwork();
    if (net && !isNetworkMatch(net)) {
      setState('wrongNetwork');
      setError(`Please switch your Freighter wallet to ${expectedNetwork} manually.`);
    } else {
      await checkConnection();
    }
  }, [checkConnection, expectedNetwork]);

  const disconnect = useCallback(() => {
    const oldKey = prevPublicKeyRef.current || publicKey;
    if (oldKey) {
      invalidateHistoryCache(oldKey);
    }
    prevPublicKeyRef.current = null;
    setState('disconnected');
    setPublicKey(null);
    setNetwork(null);
    setError(null);
    localStorage.removeItem(WALLET_CONNECTED_KEY);
  }, [publicKey]);

  return { state, publicKey, network, expectedNetwork, connect, switchNetwork, disconnect, error };
}
