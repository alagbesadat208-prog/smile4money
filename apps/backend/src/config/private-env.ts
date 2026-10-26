/**
 * Server-only configuration. This module must never be imported by frontend
 * code or exposed through Vite's public `VITE_*` environment namespace.
 */
export interface PrivateEnv {
  jwtSecret: string | undefined;
  oracleSecretKey: string | undefined;
  lichessApiToken: string | undefined;
  chessdotcomApiKey: string | undefined;
  deployerSecretKey: string | undefined;
  mainnetDeployerSecretKey: string | undefined;
  mongodbUrl: string | undefined;
}

export const privateEnv: PrivateEnv = {
  get jwtSecret() {
    return process.env.JWT_SECRET;
  },
  get oracleSecretKey() {
    return process.env.ORACLE_SECRET_KEY;
  },
  get lichessApiToken() {
    return process.env.LICHESS_API_TOKEN;
  },
  get chessdotcomApiKey() {
    return process.env.CHESSDOTCOM_API_KEY;
  },
  get deployerSecretKey() {
    return process.env.DEPLOYER_SECRET_KEY;
  },
  get mainnetDeployerSecretKey() {
    return process.env.MAINNET_DEPLOYER_SECRET_KEY;
  },
  get mongodbUrl() {
    return process.env.MONGODB_URL;
  },
};
