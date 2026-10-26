import { Networks } from '@stellar/stellar-sdk';

export type SupportedNetwork = 'testnet' | 'mainnet';
export interface AssetMetadata {
  id: 'xlm' | 'usdc';
  contractId: string;
  symbol: string;
  decimals: number;
}

const NETWORKS = {
  testnet: {
    passphrase: Networks.TESTNET,
    nativeContract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    usdc: (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
      .VITE_TESTNET_USDC_CONTRACT_ID,
  },
  mainnet: {
    passphrase: Networks.PUBLIC,
    nativeContract: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
    usdc: (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
      .VITE_MAINNET_USDC_CONTRACT_ID,
  },
} satisfies Record<SupportedNetwork, { passphrase: string; nativeContract: string; usdc?: string }>;

export function isValidContractId(value: string | undefined): value is string {
  if (!value) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return false;
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  if (bytes.length !== 35 || bytes[0] !== 16) return false;

  // StrKey stores the CRC16-XModem checksum in little-endian order.
  let checksum = 0;
  for (const byte of bytes.slice(0, 33)) {
    checksum ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = checksum & 0x8000 ? (checksum << 1) ^ 0x1021 : checksum << 1;
      checksum &= 0xffff;
    }
  }
  return bytes[33] === (checksum & 0xff) && bytes[34] === checksum >> 8;
}

export function getNetworkAssets(networkPassphrase: string): AssetMetadata[] {
  const network = Object.values(NETWORKS).find((item) => item.passphrase === networkPassphrase);
  if (!network || !isValidContractId(network.nativeContract)) return [];

  const assets: AssetMetadata[] = [
    { id: 'xlm', contractId: network.nativeContract, symbol: 'XLM', decimals: 7 },
  ];
  if (isValidContractId(network.usdc)) {
    assets.push({ id: 'usdc', contractId: network.usdc, symbol: 'USDC', decimals: 6 });
  }
  return assets;
}
