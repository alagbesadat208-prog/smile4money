import { Networks } from '@stellar/stellar-sdk';

/**
 * useNetworkStatus
 *
 * Single source of truth for network detection logic shared across the application.
 * Any change to how the expected network is resolved or how a mismatch is detected
 * is defined here.
 */

export const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  public: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
  standalone: Networks.STANDALONE,
};

export const NETWORK_LABELS: Record<string, string> = {
  mainnet: 'Mainnet',
  public: 'Mainnet',
  testnet: 'Testnet',
  futurenet: 'Futurenet',
  standalone: 'Standalone',
};

export const NETWORK_COLORS: Record<string, string> = {
  mainnet: 'bg-green-600',
  public: 'bg-green-600',
  testnet: 'bg-amber-500',
  futurenet: 'bg-orange-500',
  standalone: 'bg-gray-400',
};

/**
 * Normalizes raw network names (e.g., 'public' -> 'mainnet', 'TESTNET' -> 'testnet').
 */
export function normalizeNetworkName(raw?: string | null): string {
  if (!raw) return 'unknown';
  const lower = raw.trim().toLowerCase();
  if (lower === 'public' || lower === 'pubnet' || lower === 'mainnet') return 'mainnet';
  if (lower.includes('testnet') || lower === 'test') return 'testnet';
  if (lower.includes('futurenet') || lower === 'future') return 'futurenet';
  if (lower.includes('standalone') || lower === 'local') return 'standalone';
  return lower;
}

/**
 * Returns the application's configured expected network string.
 */
export function getExpectedNetwork(): string {
  const envVal =
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env.VITE_STELLAR_NETWORK
      : undefined;
  return normalizeNetworkName(envVal || 'testnet');
}

/**
 * Returns the canonical passphrase for the app's configured network.
 */
export function getExpectedPassphrase(): string {
  const expected = getExpectedNetwork();
  return NETWORK_PASSPHRASES[expected] ?? Networks.TESTNET;
}

/**
 * Returns the passphrase for a given network name.
 */
export function getNetworkPassphrase(networkName?: string | null): string {
  if (!networkName) return getExpectedPassphrase();
  const normalized = normalizeNetworkName(networkName);
  return NETWORK_PASSPHRASES[normalized] ?? Networks.TESTNET;
}

export const EXPECTED_NETWORK = getExpectedNetwork();
export const EXPECTED_PASSPHRASE = getExpectedPassphrase();

export interface NetworkIdentity {
  network?: string | null;
  networkPassphrase?: string | null;
}

/**
 * Checks if a wallet's network identity matches the application's expected network.
 * Handles passphrases with precedence when available.
 * Safely treats null, undefined, empty, or unknown networks as non-matching.
 */
export function isNetworkMatch(
  walletIdentity: NetworkIdentity | string | null | undefined,
): boolean {
  if (!walletIdentity) {
    return false;
  }

  const expectedPassphrase = getExpectedPassphrase();
  const expectedName = getExpectedNetwork();

  if (typeof walletIdentity === 'string') {
    const trimmed = walletIdentity.trim();
    if (trimmed === expectedPassphrase) return true;
    const normalized = normalizeNetworkName(trimmed);
    if (normalized === 'unknown') return false;
    return normalized === expectedName;
  }

  const { network, networkPassphrase } = walletIdentity;

  // Prefer checking passphrase if provided, as it is the cryptographic source of truth
  if (networkPassphrase && typeof networkPassphrase === 'string') {
    const trimmedPass = networkPassphrase.trim();
    if (trimmedPass === expectedPassphrase) {
      return true;
    }
    const lowerPass = trimmedPass.toLowerCase();
    if (expectedName === 'testnet') {
      if (lowerPass.includes('testnet') || lowerPass.includes('test sdf network')) {
        return true;
      }
      if (lowerPass.includes('pubnet') || lowerPass.includes('public global stellar')) {
        return false;
      }
    } else if (expectedName === 'mainnet') {
      if (lowerPass.includes('pubnet') || lowerPass.includes('public global stellar')) {
        return true;
      }
      if (lowerPass.includes('testnet') || lowerPass.includes('test sdf network')) {
        return false;
      }
    }
  }

  if (network && typeof network === 'string') {
    const normalized = normalizeNetworkName(network);
    return normalized !== 'unknown' && normalized === expectedName;
  }

  return false;
}

/**
 * Validates wallet network identity before a network-sensitive operation.
 * Returns an error message if invalid, or null if valid.
 */
export function validateNetworkMatch(
  walletIdentity: NetworkIdentity | string | null | undefined,
): { ok: boolean; error?: string } {
  const expectedName = getExpectedNetwork();
  const expectedLabel = NETWORK_LABELS[expectedName] ?? expectedName;

  if (!walletIdentity) {
    return {
      ok: false,
      error: `Wallet network is unavailable or unknown. Please ensure your wallet is connected to ${expectedLabel}.`,
    };
  }

  const rawName =
    typeof walletIdentity === 'string'
      ? walletIdentity
      : walletIdentity.network || 'unknown';

  const normalized = normalizeNetworkName(rawName);

  if (normalized === 'unknown' && !(typeof walletIdentity !== 'string' && walletIdentity.networkPassphrase)) {
    return {
      ok: false,
      error: `Wallet network is unknown or still loading. Please ensure your wallet is connected to ${expectedLabel}.`,
    };
  }

  if (!isNetworkMatch(walletIdentity)) {
    const actualLabel = NETWORK_LABELS[normalized] ?? rawName;
    return {
      ok: false,
      error: `Wrong network detected: expected ${expectedLabel}, but wallet is on ${actualLabel}. Please switch your wallet network to ${expectedLabel}.`,
    };
  }

  return { ok: true };
}

/**
 * Throws an actionable error if the wallet is on the wrong network or network is unknown.
 */
export function assertExpectedNetwork(
  walletIdentity: NetworkIdentity | string | null | undefined,
): void {
  const validation = validateNetworkMatch(walletIdentity);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
}

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
  const expected = getExpectedNetwork();
  // An unconnected wallet (null) is not flagged as a mismatch banner in the UI
  const isMismatch = !!walletNetwork && !isNetworkMatch(walletNetwork);
  const normalizedWallet = walletNetwork ? normalizeNetworkName(walletNetwork) : null;

  return {
    expectedNetwork: expected,
    walletNetwork,
    isMismatch,
    expectedLabel: NETWORK_LABELS[expected] ?? expected,
    expectedColor: NETWORK_COLORS[expected] ?? 'bg-gray-400',
    walletLabel: walletNetwork
      ? NETWORK_LABELS[normalizedWallet || walletNetwork] ?? walletNetwork
      : null,
  };
}
