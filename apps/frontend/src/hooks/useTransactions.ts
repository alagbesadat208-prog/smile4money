import { addressValue, buildEscrowCall, escrowServer } from '../services/escrow';
import {
  Asset,
  Networks,
  Transaction,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc,
} from '@stellar/stellar-sdk';
import type { Network } from '../types';

const RPC_URL = 'https://soroban-testnet.stellar.org';

const NETWORK_PASSPHRASES: Record<Network, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  unknown: Networks.TESTNET,
};

export interface CreateMatchInput {
  player2: string;
  stakeAmount: string;
  token: 'xlm' | 'usdc';
  gameId: string;
  platform: 'lichess' | 'chesscom';
}

type ClaimBurnMode = 'claim' | 'burn';

function getNetworkPassphrase(network: Network): string {
  return NETWORK_PASSPHRASES[network] ?? Networks.TESTNET;
}

/**
 * Sign `xdr` with the Freighter wallet and submit it to Soroban RPC.
 * Returns the transaction hash so callers can surface a receipt link.
 */
export async function signAndSubmitTransaction(
  xdr: string,
  network: Network,
  sponsored = false,
): Promise<string> {
  const server = escrowServer(getNetworkPassphrase(network));
  const networkPassphrase = getNetworkPassphrase(network);

  if (!window.freighterApi?.signTransaction) {
    throw new Error('Freighter wallet does not support signTransaction');
  }

  const { signedTxXdr } = await window.freighterApi.signTransaction(xdr, { networkPassphrase });
  if (sponsored) {
    if (network !== 'testnet') throw new Error('Sponsorship is testnet only');
    const response = await fetch('/api/transactions/sponsor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedTxXdr, optIn: true }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'Fee sponsorship failed');
    return body.hash;
  }
  const transaction = new Transaction(signedTxXdr, networkPassphrase);
  const result = await server.sendTransaction(transaction);

  if (result.status !== 'PENDING' && result.status !== 'DUPLICATE') {
    throw new Error('Transaction submission failed');
  }

  return result.hash;
}

/**
 * Transaction callbacks for the Home screen (claim, burn, create match, deposit).
 * Create and deposit prepare real escrow calls. Claim/burn retain their existing scaffolding.
 */
export function useTransactions(
  address: string | null,
  network: Network,
  options: { sponsored?: boolean; contractId?: string } = {},
) {
  const contractId =
    options.contractId ??
    (import.meta as { env?: { VITE_ESCROW_CONTRACT_ID?: string } }).env?.VITE_ESCROW_CONTRACT_ID ??
    '';
  const submit = (xdr: string) => signAndSubmitTransaction(xdr, network, options.sponsored);
  const requireWallet = () => {
    if (!address) {
      throw new Error('Wallet not connected');
    }
  };

  const handleClaim = async (amount: string): Promise<string> => {
    requireWallet();
    // Placeholder XDR — replace with an escrow contract `claim` invocation:
    // 1. Build a TransactionEnvelope with the contract call
    // 2. Sign with Freighter wallet
    // 3. Submit to Soroban RPC
    // See https://stellar-sdk.js.org/docs/server#sendtransaction
    const mockTxXdr = `AAAA...claim.${amount}`; // Placeholder
    return signAndSubmitTransaction(mockTxXdr, network);
  };

  const handleSimulateClaimBurn = async (
    mode: ClaimBurnMode,
    amount: string,
  ): Promise<{ minResourceFee?: string; error?: string }> => {
    requireWallet();
    const mockTxXdr = `AAAA...${mode}.${amount}`;
    const networkPassphrase = getNetworkPassphrase(network);
    const server = new rpc.Server(RPC_URL);
    const transaction = new Transaction(mockTxXdr, networkPassphrase);
    const result = await server.simulateTransaction(transaction);

    if ('error' in result) {
      return { error: `Transaction simulation failed: ${result.error}` };
    }

    return { minResourceFee: result.minResourceFee };
  };

  const handleBurn = async (amount: string): Promise<string | void> => {
    requireWallet();
    console.info('Burn request', amount);
  };

  const handleCreateMatch = async (data: CreateMatchInput): Promise<string> => {
    requireWallet();
    const passphrase = getNetworkPassphrase(network);
    const xdrTx = await buildEscrowCall(address!, contractId, passphrase, 'create_match', [
      addressValue(address!),
      addressValue(data.player2),
      nativeToScVal(BigInt(data.stakeAmount), { type: 'i128' }),
      data.token === 'xlm'
        ? addressValue(Asset.native().contractId(passphrase))
        : addressValue(
            (import.meta as { env?: { VITE_USDC_CONTRACT_ID?: string } }).env
              ?.VITE_USDC_CONTRACT_ID ?? '',
          ),
      nativeToScVal(data.gameId, { type: 'string' }),
      xdr.ScVal.scvVec([
        nativeToScVal(data.platform === 'lichess' ? 'Lichess' : 'ChessDotCom', { type: 'symbol' }),
      ]),
    ]);
    const hash = await submit(xdrTx);
    const result = await escrowServer(passphrase).pollTransaction(hash);
    if (result.status !== 'SUCCESS' || !result.returnValue)
      throw new Error('Match creation failed');
    return String(scValToNative(result.returnValue));
  };

  const handleDeposit = async (matchId: string): Promise<void> => {
    requireWallet();
    if (!/^\d+$/.test(matchId)) throw new Error('Invalid match ID');
    const passphrase = getNetworkPassphrase(network);
    const tx = await buildEscrowCall(address!, contractId, passphrase, 'deposit', [
      nativeToScVal(BigInt(matchId), { type: 'u64' }),
      addressValue(address!),
    ]);
    const hash = await submit(tx);
    const result = await escrowServer(passphrase).pollTransaction(hash);
    if (result.status !== 'SUCCESS') throw new Error('Deposit failed');
  };

  return { handleClaim, handleBurn, handleSimulateClaimBurn, handleCreateMatch, handleDeposit };
}
