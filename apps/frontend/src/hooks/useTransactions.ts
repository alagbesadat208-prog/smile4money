import { Transaction, rpc } from '@stellar/stellar-sdk';
import type { Network } from '../types';
import { configForWallet } from '../config/network';

export interface CreateMatchInput {
  player2: string;
  stakeAmount: string;
  token: 'xlm' | 'usdc';
  gameId: string;
  platform: 'lichess' | 'chesscom';
}

type ClaimBurnMode = 'claim' | 'burn';

// RPC endpoint and passphrase come from the same canonical record (#118):
// a mainnet passphrase used to be paired with the hard-coded testnet RPC URL.
function getNetworkPassphrase(network: Network): string {
  return configForWallet(network).networkPassphrase;
}

function getRpcUrl(network: Network): string {
  return configForWallet(network).rpcUrl;
}

/**
 * Sign `xdr` with the Freighter wallet and submit it to Soroban RPC.
 * Returns the transaction hash so callers can surface a receipt link.
 */
async function signAndSubmitTransaction(xdr: string, network: Network): Promise<string> {
  const server = new rpc.Server(getRpcUrl(network));
  const networkPassphrase = getNetworkPassphrase(network);

  if (!window.freighterApi?.signTransaction) {
    throw new Error('Freighter wallet does not support signTransaction');
  }

  const { signedTxXdr } = await window.freighterApi.signTransaction(xdr, { networkPassphrase });
  const transaction = new Transaction(signedTxXdr, networkPassphrase);
  const result = await server.sendTransaction(transaction);

  if (result.status === 'ERROR') {
    throw new Error('Transaction submission failed');
  }

  return result.hash;
}

/**
 * Transaction callbacks for the Home screen (claim, burn, create match, deposit).
 * Each action requires a connected wallet; the XDR building step is still a
 * placeholder until the escrow contract call parameters are wired up.
 */
export function useTransactions(address: string | null, network: Network) {
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
    const server = new rpc.Server(getRpcUrl(network));
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
    // Placeholder XDR — replace with an escrow contract `create_match` invocation:
    // player1 (connected wallet), player2, stake_amount, token, game_id, platform.
    const mockTxXdr = `AAAA...create_match.${data.gameId}`; // Placeholder
    await signAndSubmitTransaction(mockTxXdr, network);
    return '1'; // Placeholder match ID
  };

  const handleDeposit = async (matchId: string): Promise<void> => {
    requireWallet();
    // Placeholder XDR — replace with an escrow contract `deposit` invocation
    // for the given match.
    const mockTxXdr = `AAAA...deposit.${matchId}`; // Placeholder
    await signAndSubmitTransaction(mockTxXdr, network);
  };

  return { handleClaim, handleBurn, handleSimulateClaimBurn, handleCreateMatch, handleDeposit };
}