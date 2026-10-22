import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { getNetworkAssets, isValidContractId } from '../src/config/assets';

describe('network token configuration', () => {
  it('offers network native XLM metadata and hides unconfigured USDC', () => {
    const assets = getNetworkAssets(Networks.TESTNET);
    expect(assets).toEqual([
      {
        id: 'xlm',
        contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        symbol: 'XLM',
        decimals: 7,
      },
    ]);
  });

  it('rejects non-contract addresses and invalid StrKey checksums', () => {
    expect(isValidContractId(undefined)).toBe(false);
    expect(isValidContractId('')).toBe(false);
    expect(
      isValidContractId('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSA'),
    ).toBe(false);
    expect(
      isValidContractId('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'),
    ).toBe(true);
  });

  it('offers no asset for an unknown network', () => {
    expect(getNetworkAssets('unknown')).toEqual([]);
  });
});
