import { Networks, Transaction, rpc } from '@stellar/stellar-sdk';
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

/**
 * Readable summary of a transaction that will be submitted for signature.
 * Derived from the same typed `CreateMatchInput` used to build the transaction,
 * so the review always reflects exactly what the user is about to sign.
 */
export interface TransactionReviewSummary {
  /** Opponent (player 2) Stellar address. */
  opponent: string;
  /** Asset being staked (XLM native or USDC). */
  asset: string;
  /** Stake amount as entered by the user (decimal XLM). */
  stake: string;
  /** Target network (e.g. "Testnet"). */
  network: string;
  /** Contract action being performed (e.g. "Create match"). */
  action: string;
}

/**
 * Build a transaction review summary from the typed inputs used to construct
 * the `create_match` transaction. Kept separate from the UI so it can be
 * unit-tested against the submitted arguments without rendering a component.
 */
export function buildCreateMatchReview(
  data: CreateMatchInput,
  network: Network,
): TransactionReviewSummary {
  return {
    opponent: data.player2,
    asset: data.token === 'xlm' ? 'XLM (native)' : 'USDC',
    stake: data.stakeAmount,
    network: network.charAt(0).toUpperCase() + network.slice(1),
    action: 'Create match',
  };
}

type ClaimBurnMode = 'claim' | 'burn';

function getNetworkPassphrase(network: Network): string {
  return NETWORK_PASSPHRASES[network] ?? Networks.TESTNET;
}

/**
 * Sign `xdr` with the Freighter wallet and submit it to Soroban RPC.
 * Returns the transaction hash so callers can surface a receipt link.
 */
async function signAndSubmitTransaction(xdr: string, network: Network): Promise<string> {
  const server = new rpc.Server(RPC_URL);
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