export type WalletStatus =
  | 'checking'
  | 'notInstalled'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'wrongNetwork'
  | 'error';

export type Mode = 'claim' | 'burn';

export type Network = 'testnet' | 'mainnet' | 'unknown';

export interface WalletState {
  status: WalletStatus;
  address: string | null;
  error: string | null;
  balance: string | null;
  network: Network;
}

/** Lifecycle variants returned by EscrowContract.get_match. */
export type MatchState = 'Pending' | 'Active' | 'PendingResult' | 'Completed' | 'Cancelled';

export interface MatchDetails {
  state: MatchState;
  stakeAmount: string;
  token: string;
  player1: string;
  player2: string;
  player1Deposited: boolean;
  player2Deposited: boolean;
  createdLedger: number;
  timeoutLedgers: number;
  currentLedger: number;
}

/** Soroban unit enums decode to a single-element tuple. */
export function parseMatchState(value: unknown): MatchState {
  const state = Array.isArray(value) && value.length === 1 ? value[0] : value;
  switch (state) {
    case 'Pending':
    case 'Active':
    case 'PendingResult':
    case 'Completed':
    case 'Cancelled':
      return state;
    default:
      throw new Error('Unexpected match lifecycle state');
  }
}
