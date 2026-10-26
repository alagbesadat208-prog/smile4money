#!/usr/bin/env bash
# Shared testnet/mainnet deployment implementation for #1956 and #1957.
# Publishes metadata only after deployed WASM verification and admin readbacks.
set -euo pipefail
if [[ $# -ne 1 ]] || [[ "$1" != testnet && "$1" != mainnet ]]; then
  echo 'Usage: deploy_network.sh <testnet|mainnet>' >&2
  exit 2
fi
NETWORK="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
IDENTITY="${DEPLOYER_IDENTITY:-deployer}"
WASM_DIR="target/wasm32-unknown-unknown/release"
if [[ "$NETWORK" == testnet ]]; then
  RPC_URL="https://soroban-testnet.stellar.org"
  NETWORK_PASSPHRASE='Test SDF Network ; September 2015'
else
  RPC_URL="https://soroban-mainnet.stellar.org"
  NETWORK_PASSPHRASE='Public Global Stellar Network ; September 2015'
fi
# Fail before any on-chain transaction when required configuration is missing.
for program in stellar cargo python3 git sha256sum; do
  if ! command -v "$program" >/dev/null 2>&1; then
    echo "ERROR: $program is required for deployment." >&2; exit 1
  fi
done
if ! DEPLOYER_ADDRESS="$(stellar keys address "$IDENTITY" 2>/dev/null)" || [[ ! "$DEPLOYER_ADDRESS" =~ ^G[A-Z2-7]{55}$ ]]; then
  echo 'ERROR: configured deployer identity is missing or is not an account signer.' >&2; exit 1
fi
if [[ ! "${ESCROW_TOKEN_ADDRESS:-}" =~ ^C[A-Z2-7]{55}$ ]]; then
  echo 'ERROR: set ESCROW_TOKEN_ADDRESS to the public token contract address before deployment.' >&2; exit 1
fi
if [[ ! "${ESCROW_SAFE_ADDRESS:-}" =~ ^G[A-Z2-7]{55}$ ]]; then
  echo 'ERROR: set ESCROW_SAFE_ADDRESS to the public, operator-verified emergency safe account.' >&2; exit 1
fi
if [[ "$NETWORK" == mainnet ]]; then
  echo 'WARNING: deploying to PUBLIC MAINNET spends real, irreversible XLM.' >&2
  read -r -p 'Type exactly yes to authorize mainnet deployment: ' answer
  [[ "$answer" == yes ]] || { echo 'Mainnet deployment cancelled.' >&2; exit 1; }
else
  # Optional friendbot funding; failure is non-fatal if the account is already funded.
  curl -fsS --max-time 15 "https://friendbot.stellar.org?addr=$DEPLOYER_ADDRESS" >/dev/null 2>&1 || true
fi

echo "Building and deploying $NETWORK contracts..."
cargo build --target wasm32-unknown-unknown --release --quiet
ESCROW_WASM="$WASM_DIR/escrow.wasm"
ORACLE_WASM="$WASM_DIR/oracle.wasm"
[[ -s "$ESCROW_WASM" && -s "$ORACLE_WASM" ]] || { echo 'ERROR: expected escrow.wasm and oracle.wasm are missing.' >&2; exit 1; }
CONTRACT_ESCROW="$(stellar contract deploy --wasm "$ESCROW_WASM" --source "$IDENTITY" --network "$NETWORK" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")"
CONTRACT_ORACLE="$(stellar contract deploy --wasm "$ORACLE_WASM" --source "$IDENTITY" --network "$NETWORK" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")"
for id in "$CONTRACT_ESCROW" "$CONTRACT_ORACLE"; do
  [[ "$id" =~ ^C[A-Z2-7]{55}$ ]] || { echo 'ERROR: deployment did not return a valid contract ID; no metadata published.' >&2; exit 1; }
done
bash "$SCRIPT_DIR/verify_wasm_hash.sh" "$CONTRACT_ESCROW" "$ESCROW_WASM" "$NETWORK" "$RPC_URL" "$NETWORK_PASSPHRASE"
bash "$SCRIPT_DIR/verify_wasm_hash.sh" "$CONTRACT_ORACLE" "$ORACLE_WASM" "$NETWORK" "$RPC_URL" "$NETWORK_PASSPHRASE"

# Existing contract initializers: oracle(admin), escrow(oracle, admin, token,
# safe_address, dispute_window_ledgers?, timeout_ledgers?).
stellar contract invoke --id "$CONTRACT_ORACLE" --source "$IDENTITY" --network "$NETWORK" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" -- initialize --admin "$DEPLOYER_ADDRESS" >/dev/null
stellar contract invoke --id "$CONTRACT_ESCROW" --source "$IDENTITY" --network "$NETWORK" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" -- initialize --oracle "$CONTRACT_ORACLE" --admin "$DEPLOYER_ADDRESS" --token "$ESCROW_TOKEN_ADDRESS" --safe_address "$ESCROW_SAFE_ADDRESS" >/dev/null

# Required: fail closed on either readback failure or mismatch BEFORE writing
# the manifest or .env, and before sending the optional escrow reserve payment.
bash "$SCRIPT_DIR/verify_admin_readback.sh" oracle "$CONTRACT_ORACLE" "$IDENTITY" "$NETWORK" "$RPC_URL" "$NETWORK_PASSPHRASE"
bash "$SCRIPT_DIR/verify_admin_readback.sh" escrow "$CONTRACT_ESCROW" "$IDENTITY" "$NETWORK" "$RPC_URL" "$NETWORK_PASSPHRASE"

python3 "$SCRIPT_DIR/create_deployment_manifest.py" \
  --network "$NETWORK" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" \
  --escrow-id "$CONTRACT_ESCROW" --oracle-id "$CONTRACT_ORACLE" \
  --escrow-wasm "$ESCROW_WASM" --oracle-wasm "$ORACLE_WASM" \
  --admin "$DEPLOYER_ADDRESS" --token "$ESCROW_TOKEN_ADDRESS" --safe-address "$ESCROW_SAFE_ADDRESS"

# Local .env is NOT uploaded to CI (it may contain tokens and private credentials).
ENV_FILE=.env
[[ -f "$ENV_FILE" ]] || cp .env.example "$ENV_FILE"
set_env_value() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
set_env_value CONTRACT_ESCROW "$CONTRACT_ESCROW"
set_env_value CONTRACT_ORACLE "$CONTRACT_ORACLE"
set_env_value STELLAR_NETWORK "$NETWORK"
set_env_value STELLAR_RPC_URL "$RPC_URL"
set_env_value VITE_STELLAR_NETWORK "$NETWORK"
set_env_value VITE_STELLAR_RPC_URL "$RPC_URL"

echo "$NETWORK deployment initialized and administrators verified."
echo "Local manifest: deployments/$NETWORK.json (NOT signed locally)."
