/**
 * useNetworkStatus
 *
 * Single source of truth for network detection logic shared by
 * NetworkBanner and NetworkBadge. Any change to how the expected
 * network is resolved or how a mismatch is detected only needs to
 * be made here.
 */

import { publicEnv } from '../config/public-env';

const EXPECTED_NETWORK = publicEnv.stellarNetwork;

export const NETWORK_LABELS: Record<string, string> = {
  mainnet: 'Mainnet',
  testnet: 'Testnet',
  futurenet: 'Futurenet',
  standalone: 'Standalone',
};

export const NETWORK_COLORS: Record<string, string> = {
  mainnet: 'bg-green-600',
  testnet: 'bg-amber-500',
  futurenet: 'bg-orange-500',
  standalone: 'bg-gray-400',
};

export interface NetworkStatus {
  /** The network name the app expects (from VITE_STELLAR_NETWORK). */
  expectedNetwork: string;
  /** The wallet's current network, or null if unknown / not connected. */
  walletNetwork: string | null;
  /** True when the wallet is on a different network than expected. */
  isMismatch: boolean;
  /** Human-readable label for the expected network. */
  expectedLabel: string;
  /** Tailwind colour class for the expected network badge. */
  expectedColor: string;
  /** Human-readable label for the wallet's current network (falls back to the raw value). */
  walletLabel: string | null;
}

/**
 * Returns derived network status from a raw wallet network string.
 *
 * @param walletNetwork - The network string reported by the connected wallet,
 *   or null when no wallet is connected.
 */
export function useNetworkStatus(walletNetwork: string | null): NetworkStatus {
  const isMismatch = !!walletNetwork && walletNetwork !== EXPECTED_NETWORK;

  return {
    expectedNetwork: EXPECTED_NETWORK,
    walletNetwork,
    isMismatch,
    expectedLabel: NETWORK_LABELS[EXPECTED_NETWORK] ?? EXPECTED_NETWORK,
    expectedColor: NETWORK_COLORS[EXPECTED_NETWORK] ?? 'bg-gray-400',
    walletLabel: walletNetwork ? (NETWORK_LABELS[walletNetwork] ?? walletNetwork) : null,
  };
}
