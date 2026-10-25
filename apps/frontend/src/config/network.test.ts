import { describe, it, expect } from 'vitest';
import {
  APP_NETWORK,
  APP_NETWORK_CONFIG,
  NETWORKS,
  configForWallet,
  networkConfig,
} from './network';

/** Frontend network lookups come from the canonical table (#118). */
describe('frontend network config', () => {
  it('defaults the app network to testnet', () => {
    expect(APP_NETWORK).toBe('testnet');
    expect(APP_NETWORK_CONFIG).toBe(NETWORKS.testnet);
  });

  it('pairs each wallet network with its own RPC endpoint and passphrase', () => {
    expect(configForWallet('mainnet')).toBe(NETWORKS.mainnet);
    expect(configForWallet('mainnet').rpcUrl).not.toBe(NETWORKS.testnet.rpcUrl);
    expect(configForWallet('testnet').networkPassphrase).toBe('Test SDF Network ; September 2015');
  });

  it("falls back to the app's network for an unrecognised wallet network", () => {
    expect(configForWallet('unknown')).toBe(APP_NETWORK_CONFIG);
  });

  it('every network has distinct RPC, Horizon and passphrase values', () => {
    const all = Object.values(NETWORKS);
    for (const key of ['rpcUrl', 'horizonUrl', 'networkPassphrase'] as const) {
      expect(new Set(all.map((n) => n[key])).size).toBe(all.length);
    }
  });

  it('rejects an unknown network name', () => {
    expect(() => networkConfig('moonnet')).toThrow(/Unknown Stellar network/);
  });
});
