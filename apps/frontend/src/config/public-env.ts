/**
 * The only environment values intentionally exposed to browser code.
 *
 * Vite replaces `VITE_*` values at build time. Keep this module limited to
 * public configuration; server credentials must never be read here.
 */
export interface PublicEnv {
  stellarNetwork: string;
  stellarRpcUrl: string;
  leaderboardContractId: string;
}

const rawEnv = import.meta.env;

export const publicEnv: PublicEnv = {
  stellarNetwork: rawEnv.VITE_STELLAR_NETWORK ?? 'testnet',
  stellarRpcUrl: rawEnv.VITE_STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  leaderboardContractId: rawEnv.VITE_LEADERBOARD_CONTRACT_ID ?? '',
};
