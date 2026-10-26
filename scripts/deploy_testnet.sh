#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# deploy_testnet.sh — Build and deploy smile4money contracts to Stellar testnet
#
# Prerequisites:
#   stellar keys generate deployer --network testnet
#
# Usage:
#   ./scripts/deploy_testnet.sh
#
# Writes CONTRACT_ESCROW and CONTRACT_ORACLE to .env on success.
# ---------------------------------------------------------------------------

NETWORK="testnet"
RPC_URL="https://soroban-testnet.stellar.org"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
IDENTITY="deployer"
WASM_DIR="target/wasm32-unknown-unknown/release"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Fail before friendbot, account preparation, or contract deployment.
bash "$SCRIPT_DIR/check_stellar_compat.sh" --network "$NETWORK"

# Verify stellar CLI is available
if ! command -v stellar &>/dev/null; then
  echo "Error: stellar CLI not found. Install it from https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli" >&2
  exit 1
fi

# Verify the deployer identity exists
if ! stellar keys show "$IDENTITY" &>/dev/null; then
  echo "Error: identity '$IDENTITY' not found. Run: stellar keys generate $IDENTITY --network $NETWORK" >&2
  exit 1
fi

DEPLOYER_ADDRESS=$(stellar keys address "$IDENTITY")
echo "Deployer: $DEPLOYER_ADDRESS"

# Fund account via friendbot if needed
echo "Funding deployer account via friendbot..."
curl -sf "https://friendbot.stellar.org?addr=${DEPLOYER_ADDRESS}" -o /dev/null || true

# Build WASM
echo "Building contracts..."
cargo build --target wasm32-unknown-unknown --release --quiet

ESCROW_WASM="$WASM_DIR/escrow.wasm"
ORACLE_WASM="$WASM_DIR/oracle.wasm"

if [[ ! -f "$ESCROW_WASM" ]]; then
  echo "Error: $ESCROW_WASM not found after build" >&2
  exit 1
fi
if [[ ! -f "$ORACLE_WASM" ]]; then
  echo "Error: $ORACLE_WASM not found after build" >&2
  exit 1
fi

bash "$SCRIPT_DIR/check_stellar_compat.sh" "$ESCROW_WASM" "$ORACLE_WASM"
# Deploy escrow contract
echo "Deploying escrow contract..."
CONTRACT_ESCROW=$(stellar contract deploy \
  --wasm "$ESCROW_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE")
echo "Escrow contract: $CONTRACT_ESCROW"

# Deploy oracle contract
echo "Deploying oracle contract..."
CONTRACT_ORACLE=$(stellar contract deploy \
  --wasm "$ORACLE_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE")
echo "Oracle contract: $CONTRACT_ORACLE"

echo "Verifying deployed WASM hashes..."
bash "$SCRIPT_DIR/verify_wasm_hash.sh" "$CONTRACT_ESCROW" "$ESCROW_WASM" "$NETWORK" "$RPC_URL" "$NETWORK_PASSPHRASE"
bash "$SCRIPT_DIR/verify_wasm_hash.sh" "$CONTRACT_ORACLE" "$ORACLE_WASM" "$NETWORK" "$RPC_URL" "$NETWORK_PASSPHRASE"

# Initialize oracle contract (admin = deployer)
echo "Initializing oracle contract..."
stellar contract invoke \
  --id "$CONTRACT_ORACLE" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- initialize \
  --admin "$DEPLOYER_ADDRESS"

# Initialize escrow contract (oracle = oracle contract address, admin = deployer)
echo "Initializing escrow contract..."
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- initialize \
  --oracle "$CONTRACT_ORACLE" \
  --admin "$DEPLOYER_ADDRESS"

# ---------------------------------------------------------------------------
# Fund escrow contract with a 1.5 XLM (15,000,000 stroops) native reserve
# buffer. Every Stellar account needs ≥ 1 XLM minimum balance to exist;
# payouts that would drop the escrow below that threshold abort at the
# protocol layer, leaving the match state machine stuck. The 0.5 XLM surplus
# covers rent / inclusion fees. See docs/deployment.md for details.
# ---------------------------------------------------------------------------
ESCROW_STELLAR_ADDRESS=$(stellar contract id address --id "$CONTRACT_ESCROW")
echo "Funding escrow reserve buffer (1.5 XLM -> $ESCROW_STELLAR_ADDRESS)..."
stellar tx build \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --operation payment \
    --source-account "$DEPLOYER_ADDRESS" \
    --destination "$ESCROW_STELLAR_ADDRESS" \
    --asset native \
    --amount 15000000 \
  2>/dev/null | stellar tx send --source "$IDENTITY" --network "$NETWORK" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" >/dev/null || {
  echo "Warning: failed to send 1.5 XLM reserve to escrow. Please fund it manually:"
  echo "  stellar tx build --source $IDENTITY --network $NETWORK " \
       "--operation payment --source-account $DEPLOYER_ADDRESS " \
       "--destination $ESCROW_STELLAR_ADDRESS --asset native --amount 15000000 " \
       "| stellar tx send --source $IDENTITY --network $NETWORK"
}

# Write contract IDs to .env
ENV_FILE=".env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp .env.example "$ENV_FILE"
fi

# Update or append CONTRACT_ESCROW
if grep -q "^CONTRACT_ESCROW=" "$ENV_FILE"; then
  sed -i "s|^CONTRACT_ESCROW=.*|CONTRACT_ESCROW=$CONTRACT_ESCROW|" "$ENV_FILE"
else
  echo "CONTRACT_ESCROW=$CONTRACT_ESCROW" >> "$ENV_FILE"
fi

# Update or append CONTRACT_ORACLE
if grep -q "^CONTRACT_ORACLE=" "$ENV_FILE"; then
  sed -i "s|^CONTRACT_ORACLE=.*|CONTRACT_ORACLE=$CONTRACT_ORACLE|" "$ENV_FILE"
else
  echo "CONTRACT_ORACLE=$CONTRACT_ORACLE" >> "$ENV_FILE"
fi

echo ""
echo "Deployment complete."
echo "  Escrow:  $CONTRACT_ESCROW"
echo "  Oracle:  $CONTRACT_ORACLE"
echo "Contract IDs written to $ENV_FILE"
