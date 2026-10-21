import { useState, useEffect, useCallback } from 'react';
import { publicEnv } from '../config/public-env';

export type WalletState =
  'checking' | 'notInstalled' | 'disconnected' | 'connecting' | 'connected' | 'wrongNetwork';

declare global {
  interface Window {
    stellar?: {
      isConnected: () => Promise<{ isConnected: boolean }>;
      getPublicKey: () => Promise<string>;
      getNetwork: () => Promise<{ network: string; networkPassphrase: string }>;
      setAllowed: () => Promise<{ error?: { code: number; message: string } }>;
    };
  }
}

const EXPECTED_NETWORK = publicEnv.stellarNetwork;

/** localStorage key used to persist the user's connection preference. */
const WALLET_CONNECTED_KEY = 'wallet_connected';

export function useWallet() {
  const [state, setState] = useState<WalletState>('checking');
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expectedNetwork = EXPECTED_NETWORK;

  const checkConnection = useCallback(async () => {
    if (!window.stellar) {
      setState('notInstalled');
      return;
    }

    try {
      const { isConnected } = await window.stellar.isConnected();
      if (!isConnected) {
        setState('disconnected');
        return;
      }

      const pk = await window.stellar.getPublicKey();
      const net = await window.stellar.getNetwork();

      setPublicKey(pk);
      setNetwork(net.network);

      if (net.network !== EXPECTED_NETWORK) {
        setState('wrongNetwork');
      } else {
        setState('connected');
      }
    } catch {
      setState('disconnected');
    }
  }, []);

  // On mount: if the user previously connected, attempt silent auto-reconnect.
  // We only try if Freighter reports it is still connected — this avoids
  // popping an unexpected permission prompt on a fresh session.
  useEffect(() => {
    const stored = localStorage.getItem(WALLET_CONNECTED_KEY);
    if (stored === 'true') {
      // Attempt auto-reconnect; checkConnection will set state appropriately
      // if Freighter is no longer connected or the extension isn't installed.
      checkConnection();
    } else {
      // No stored preference — resolve immediately so the UI isn't stuck in
      // 'checking' state.
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

      setPublicKey(pk);
      setNetwork(net.network);

      if (net.network !== EXPECTED_NETWORK) {
        setState('wrongNetwork');
        setError(`Wrong network: expected ${EXPECTED_NETWORK}, got ${net.network}`);
        // Still persist the preference — user is connected, just on wrong network
        localStorage.setItem(WALLET_CONNECTED_KEY, 'true');
      } else {
        setState('connected');
        // Persist the successful connection so we can auto-reconnect next session
        localStorage.setItem(WALLET_CONNECTED_KEY, 'true');
      }
    } catch (err) {
      setState('disconnected');
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    setError(null);
    const net = await window.stellar?.getNetwork();
    if (net && net.network !== EXPECTED_NETWORK) {
      setState('wrongNetwork');
      setError(`Please switch your Freighter wallet to ${EXPECTED_NETWORK} manually.`);
    } else {
      await checkConnection();
    }
  }, [checkConnection]);

  const disconnect = useCallback(() => {
    setState('disconnected');
    setPublicKey(null);
    setNetwork(null);
    setError(null);
    // Clear the stored preference so we don't auto-reconnect next session
    localStorage.removeItem(WALLET_CONNECTED_KEY);
  }, []);

  return { state, publicKey, network, expectedNetwork, connect, switchNetwork, disconnect, error };
}
