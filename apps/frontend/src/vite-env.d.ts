interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_STELLAR_NETWORK?: string;
  readonly VITE_STELLAR_RPC_URL?: string;
  readonly VITE_LEADERBOARD_CONTRACT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
