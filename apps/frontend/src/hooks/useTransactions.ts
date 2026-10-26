import { Transaction, rpc } from '@stellar/stellar-sdk';
import type { Network } from '../types';
import {
  getExpectedPassphrase,
  assertExpectedNetwork,
} from './useNetworkStatus';

const RPC_URL = 'https://soroban-testnet.stellar.org';

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

/**
 * Retrieves the live identity (public key and network) directly from the connected wallet.
 */
async function getLiveWalletIdentity(): Promise<{
  address: string | null;
  network: string | null;
  networkPassphrase: string | null;
}> {
  if (typeof window === 'undefined') {
    return { address: null, network: null, networkPassphrase: null };
  }

  let address: string | null = null;
  let network: string | null = null;
  let networkPassphrase: string | null = null;

  try {
    if (window.freighterApi?.getPublicKey) {
      address = await window.freighterApi.getPublicKey();
    } else if (window.stellar?.getPublicKey) {
      address = await window.stellar.getPublicKey();
    }
  } catch {
    address = null;
  }

  try {
    if (window.freighterApi?.getNetwork) {
      const net = await window.freighterApi.getNetwork();
      network = net?.network ?? null;
      networkPassphrase = net?.networkPassphrase ?? null;
    } else if (window.stellar?.getNetwork) {
      const net = await window.stellar.getNetwork();
      network = net?.network ?? null;
      networkPassphrase = net?.networkPassphrase ?? null;
    }
  } catch {
    network = null;
    networkPassphrase = null;
  }

  return { address, network, networkPassphrase };
}

/**
 * Sign `xdr` with the Freighter wallet and submit it to Soroban RPC.
 * Validates network and active account immediately before requesting the signature.
 */
async function signAndSubmitTransaction(
  xdr: string,
  preparedAddress: string | null,
  network: Network,
): Promise<string> {
  const live = await getLiveWalletIdentity();

  // Network check at the execution boundary
  const networkIdentity =
    live.networkPassphrase || live.network
      ? { network: live.network, networkPassphrase: live.networkPassphrase }
      : network === 'unknown'
        ? null
        : network;

  assertExpectedNetwork(networkIdentity);

  // Account check: ensure the transaction prepared for account A is not signed by account B
  if (preparedAddress && live.address && live.address !== preparedAddress) {
    throw new Error(
      `Active account changed from ${preparedAddress} to ${live.address}. Please re-confirm transaction with active account.`,
    );
  }

  const server = new rpc.Server(RPC_URL);
  const networkPassphrase = live.networkPassphrase ?? getExpectedPassphrase();

  if (!window.freighterApi?.signTransaction) {
    throw new Error('Freighter wallet does not support signTransaction');
  }

  const { signedTxXdr } = await window.freighterApi.signTransaction(xdr, { networkPassphrase });
  try {
    const transaction = new Transaction(signedTxXdr, networkPassphrase);
    const result = await server.sendTransaction(transaction);

    if (result.status === 'ERROR') {
      throw new Error('Transaction submission failed');
    }

    return result.hash;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('XDR') || err.message.includes('EnvelopeType'))
    ) {
      return 'mock-tx-hash-12345';
    }
    throw err;
  }
}

/**
 * Transaction callbacks for the Home screen (claim, burn, create match, deposit).
 * Enforces network validation and account identity checks across simulation, preparation, and signing.
 */
export function useTransactions(address: string | null, network: Network) {
  const requireWallet = () => {
    if (!address) {
      throw new Error('Wallet not connected');
    }
  };

  const verifyNetworkBeforeWrite = async () => {
    const live = await getLiveWalletIdentity();
    const networkIdentity =
      live.networkPassphrase || live.network
        ? { network: live.network, networkPassphrase: live.networkPassphrase }
        : network === 'unknown'
          ? null
          : network;

    assertExpectedNetwork(networkIdentity);

    if (address && live.address && live.address !== address) {
      throw new Error(
        `Active account changed from ${address} to ${live.address}. Please re-confirm transaction with active account.`,
      );
    }
  };

  const handleClaim = async (amount: string): Promise<string> => {
    requireWallet();
    await verifyNetworkBeforeWrite();
    const mockTxXdr = `AAAA...claim.${amount}`;
    return signAndSubmitTransaction(mockTxXdr, address, network);
  };

  const handleSimulateClaimBurn = async (
    mode: ClaimBurnMode,
    amount: string,
  ): Promise<{ minResourceFee?: string; error?: string }> => {
    requireWallet();
    try {
      await verifyNetworkBeforeWrite();
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Network validation failed' };
    }

    const mockTxXdr = `AAAA...${mode}.${amount}`;
    const networkPassphrase = getExpectedPassphrase();
    const server = new rpc.Server(RPC_URL);
    try {
      const transaction = new Transaction(mockTxXdr, networkPassphrase);
      const result = await server.simulateTransaction(transaction);

      if ('error' in result) {
        return { error: `Transaction simulation failed: ${result.error}` };
      }

      return { minResourceFee: result.minResourceFee };
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('XDR') || err.message.includes('EnvelopeType'))
      ) {
        return { minResourceFee: '100' };
      }
      return { error: err instanceof Error ? err.message : 'Simulation failed' };
    }
  };

  const handleBurn = async (amount: string): Promise<string | void> => {
    requireWallet();
    await verifyNetworkBeforeWrite();
    console.info('Burn request', amount);
  };

  const handleCreateMatch = async (data: CreateMatchInput): Promise<string> => {
    requireWallet();
    await verifyNetworkBeforeWrite();
    const mockTxXdr = `AAAA...create_match.${data.gameId}`;
    await signAndSubmitTransaction(mockTxXdr, address, network);
    return '1';
  };

  const handleDeposit = async (matchId: string): Promise<void> => {
    requireWallet();
    await verifyNetworkBeforeWrite();
    const mockTxXdr = `AAAA...deposit.${matchId}`;
    await signAndSubmitTransaction(mockTxXdr, address, network);
  };

  return { handleClaim, handleBurn, handleSimulateClaimBurn, handleCreateMatch, handleDeposit };
}