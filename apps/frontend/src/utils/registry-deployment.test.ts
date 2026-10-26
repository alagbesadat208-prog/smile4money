import { describe, expect, it } from 'vitest';
import { isExpectedDeployment, resolveRegistryAddress } from './registry-deployment';

const expected = {
  registryId: 'registry-contract',
  networkId: 'testnet-network-id',
  minimumRevision: 4,
  latestLedger: 900,
};

const deployment = {
  registryId: 'registry-contract',
  networkId: 'testnet-network-id',
  address: 'contract-address',
  revision: 4,
  effectiveLedger: 800,
};

describe('isExpectedDeployment', () => {
  it('accepts the expected network, registry, and current revision', () => {
    expect(isExpectedDeployment(deployment, expected)).toBe(true);
  });

  it('rejects wrong identities and stale or future records', () => {
    expect(isExpectedDeployment({ ...deployment, registryId: 'other' }, expected)).toBe(false);
    expect(isExpectedDeployment({ ...deployment, networkId: 'mainnet' }, expected)).toBe(false);
    expect(isExpectedDeployment({ ...deployment, revision: 3 }, expected)).toBe(false);
    expect(isExpectedDeployment({ ...deployment, effectiveLedger: 901 }, expected)).toBe(false);
  });

  it('returns no address unless deployment metadata is current', () => {
    expect(resolveRegistryAddress(deployment, expected)).toBe('contract-address');
    expect(resolveRegistryAddress({ ...deployment, revision: 2 }, expected)).toBeNull();
  });
});
