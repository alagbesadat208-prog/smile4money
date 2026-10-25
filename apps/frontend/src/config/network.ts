/**
 * The frontend's view of the canonical network table (issue #118).
 *
 * Every RPC URL, Horizon URL and passphrase comes from networks.generated.ts,
 * which scripts/network_config.py generates from environments.toml. Look a
 * network up here instead of writing one of those values in a component;
 * `python scripts/network_config.py --check` fails CI if one is hard-coded.
 */
import type { Network } from '../types';
import {
  NETWORKS,
  isNetworkName,
  networkConfig,
  type NetworkConfig,
  type NetworkName,
} from './networks.generated';

export { NETWORKS, isNetworkName, networkConfig };
export type { NetworkConfig, NetworkName };

function configuredNetwork(): NetworkName {
  const raw =
    typeof import.meta !== 'undefined'
      ? (import.meta as { env?: { VITE_STELLAR_NETWORK?: string } }).env?.VITE_STELLAR_NETWORK
      : undefined;
  if (raw === undefined || raw === '') return 'testnet';
  // A typo here would otherwise silently point the app at testnet.
  return networkConfig(raw).network;
}

/** The network this build targets (`VITE_STELLAR_NETWORK`, default `testnet`). */
export const APP_NETWORK: NetworkName = configuredNetwork();

/** Canonical config for the app's own network. */
export const APP_NETWORK_CONFIG: NetworkConfig = NETWORKS[APP_NETWORK];

/**
 * Config for the network a wallet reports. An unrecognised wallet network
 * (`'unknown'`) falls back to the app's network, so RPC endpoint and
 * passphrase always come from the same record and can never disagree.
 */
export function configForWallet(network: Network | string): NetworkConfig {
  return isNetworkName(network) ? NETWORKS[network] : APP_NETWORK_CONFIG;
}
