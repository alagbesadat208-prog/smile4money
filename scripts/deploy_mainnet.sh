#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# deploy_mainnet.sh — Build and deploy smile4money contracts to Stellar mainnet
#
# Prerequisites:
#   stellar keys generate deployer --network mainnet
#   Deployer account must be funded with real XLM before running this script.
#
# Usage:
#   ./scripts/deploy_mainnet.sh
#
# Writes CONTRACT_ESCROW and CONTRACT_ORACLE to .env on success, then stores a
# permanent mainnet deployment record as deployments/mainnet.json.
#
# WARNING: This deploys to the Stellar PUBLIC network. Transactions are
# irreversible and consume real XLM. Verify all parameters before proceeding.
# ---------------------------------------------------------------------------

NETWORK="mainnet"
RPC_URL="https://soroban-mainnet.stellar.org"
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
IDENTITY="deployer"
WASM_DIR="target/wasm32-unknown-unknown/release"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Independent environment approval is required BEFORE any deployer or network access.
python3 "$SCRIPT_DIR/verify_production_approval.py"
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
echo "Network:  $NETWORK (PUBLIC — real XLM will be spent)"
echo ""
echo "WARNING: This will deploy contracts to the Stellar PUBLIC network."
echo "         Transactions are irreversible and will consume real XLM."
echo ""
read -r -p 'Type exactly "yes" to confirm mainnet deployment: ' confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Aborted. (Input was not exactly \"yes\")"
  exit 1
fi

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

# Deploy oracle contract
echo "Deploying oracle contract..."
CONTRACT_ORACLE=$(stellar contract deploy \
  --wasm "$ORACLE_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE")

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
# On mainnet this consumes an additional 1.5 XLM from the deployer account
# (ensure the deployer has enough XLM before running).
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
  2>/dev/null | stellar tx send --source "$IDENTITY" --network "$NETWORK" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" || {
  echo "ERROR: failed to send 1.5 XLM reserve buffer to escrow $ESCROW_STELLAR_ADDRESS." >&2
  echo "Please submit the payment op manually before proceeding to use the contract." >&2
  exit 1
}

main() {
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
  echo "Network:  $NETWORK (PUBLIC — real XLM will be spent)"
  echo ""
  echo "WARNING: This will deploy contracts to the Stellar PUBLIC network."
  echo "         Transactions are irreversible and will consume real XLM."
  echo ""
  read -r -p 'Type exactly "yes" to confirm mainnet deployment: ' confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted. (Input was not exactly \"yes\")"
    exit 1
  fi

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
  # On mainnet this consumes an additional 1.5 XLM from the deployer account
  # (ensure the deployer has enough XLM before running).
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
    2>/dev/null | stellar tx send --source "$IDENTITY" --network "$NETWORK" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" || {
    echo "ERROR: failed to send 1.5 XLM reserve buffer to escrow $ESCROW_STELLAR_ADDRESS." >&2
    echo "Please submit the payment op manually before proceeding to use the contract." >&2
    exit 1
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

  # Update STELLAR_NETWORK and RPC URL in .env to reflect mainnet
  if grep -q "^STELLAR_NETWORK=" "$ENV_FILE"; then
    sed -i "s|^STELLAR_NETWORK=.*|STELLAR_NETWORK=mainnet|" "$ENV_FILE"
  fi
  if grep -q "^STELLAR_RPC_URL=" "$ENV_FILE"; then
    sed -i "s|^STELLAR_RPC_URL=.*|STELLAR_RPC_URL=$RPC_URL|" "$ENV_FILE"
  fi
  if grep -q "^VITE_STELLAR_NETWORK=" "$ENV_FILE"; then
    sed -i "s|^VITE_STELLAR_NETWORK=.*|VITE_STELLAR_NETWORK=mainnet|" "$ENV_FILE"
  fi
  if grep -q "^VITE_STELLAR_RPC_URL=" "$ENV_FILE"; then
    sed -i "s|^VITE_STELLAR_RPC_URL=.*|VITE_STELLAR_RPC_URL=$RPC_URL|" "$ENV_FILE"
  fi

  write_deployment_manifest "mainnet" "$CONTRACT_ESCROW" "$CONTRACT_ORACLE"

  echo ""
  echo "Mainnet deployment complete."
  echo "  Escrow:  $CONTRACT_ESCROW"
  echo "  Oracle:  $CONTRACT_ORACLE"
  echo "Contract IDs written to $ENV_FILE"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
if grep -q "^VITE_STELLAR_NETWORK=" "$ENV_FILE"; then
  sed -i "s|^VITE_STELLAR_NETWORK=.*|VITE_STELLAR_NETWORK=mainnet|" "$ENV_FILE"
fi
if grep -q "^VITE_STELLAR_RPC_URL=" "$ENV_FILE"; then
  sed -i "s|^VITE_STELLAR_RPC_URL=.*|VITE_STELLAR_RPC_URL=$RPC_URL|" "$ENV_FILE"
fi

echo ""
echo "Mainnet deployment complete. Contract IDs written to $ENV_FILE"
