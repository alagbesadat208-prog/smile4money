import { Asset, Networks } from '@stellar/stellar-sdk';

/** Native SAC identity is derived from the network, never from a supplied symbol.
 * Stellar native amounts have seven decimals:
 * https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/assets
 */
export function formatTokenAmount(raw: string, token: string, passphrase: string): string {
  const knownNetwork = passphrase === Networks.TESTNET || passphrase === Networks.PUBLIC;
  if (!knownNetwork || token !== Asset.native().contractId(passphrase)) {
    return `${raw} smallest units (${token || 'unknown asset'})`;
  }
  const amount = BigInt(raw);
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % 10000000n).toString().padStart(7, '0').replace(/0+$/, '');
  return `${amount < 0n ? '-' : ''}${absolute / 10000000n}${fraction ? `.${fraction}` : ''} XLM`;
}
