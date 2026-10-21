import { Networks, StrKey } from '@stellar/stellar-sdk';
import type { Network } from './types';

const env = (import.meta as { env?: Record<string, string> }).env ?? {};
const configuredNetwork = env.VITE_STELLAR_NETWORK ?? 'testnet';
export const deployment = {
  network: (configuredNetwork === 'testnet' || configuredNetwork === 'mainnet'
    ? configuredNetwork
    : 'unknown') as Network,
  rpcUrl:
    env.VITE_STELLAR_RPC_URL ??
    (configuredNetwork === 'testnet' ? 'https://soroban-testnet.stellar.org' : ''),
  escrowId: env.VITE_ESCROW_CONTRACT_ID ?? '',
  horizonUrl:
    configuredNetwork === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org',
  networkPassphrase: configuredNetwork === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
};
export const deploymentReady =
  deployment.network !== 'unknown' &&
  !!deployment.rpcUrl &&
  StrKey.isValidContract(deployment.escrowId);
export function setupState(
  status: string,
  network: Network,
  configured = deploymentReady,
  expected = deployment.network,
) {
  if (status !== 'connected' && status !== 'wrongNetwork') return 'disconnected';
  if (!configured) return 'unconfigured';
  if (network === 'unknown' || network !== expected) return 'unsupported';
  return 'ready';
}
