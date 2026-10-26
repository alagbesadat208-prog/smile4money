#!/usr/bin/env bash
# Compare read-only on-chain admin state with the public address of the configured signer.
# This script does not print RPC responses or mismatching addresses.
set -euo pipefail
if [[ $# -ne 6 ]]; then
  echo 'Usage: verify_admin_readback.sh <role> <contract-id> <identity> <network> <rpc-url> <passphrase>' >&2
  exit 2
fi
ROLE="$1"; CONTRACT_ID="$2"; IDENTITY="$3"; NETWORK="$4"; RPC_URL="$5"; PASSPHRASE="$6"
case "$ROLE" in escrow|oracle) ;; *) echo 'ERROR: unknown contract role' >&2; exit 2 ;; esac
if ! EXPECTED="$(stellar keys address "$IDENTITY" 2>/dev/null)" || [[ ! "$EXPECTED" =~ ^G[A-Z2-7]{55}$ ]]; then
  echo "ERROR: $ROLE admin verification unavailable: signer identity has no valid public address. Check the configured key." >&2
  exit 1
fi
if ! RECEIVED="$(stellar contract invoke --id "$CONTRACT_ID" --source "$IDENTITY" --network "$NETWORK" --rpc-url "$RPC_URL" --network-passphrase "$PASSPHRASE" -- get_admin 2>/dev/null)"; then
  echo "ERROR: $ROLE admin readback failed. Confirm that the deployed WASM exposes get_admin, that initialization succeeded, and that RPC is reachable. No deployment metadata published." >&2
  exit 1
fi
# The CLI can emit an address as either a bare StrKey or a JSON string.
RECEIVED="${RECEIVED//$'\r'/}"
RECEIVED="${RECEIVED//$'\n'/}"
if [[ "$RECEIVED" == '"'*'"' ]]; then RECEIVED="${RECEIVED:1:${#RECEIVED}-2}"; fi
if [[ "$RECEIVED" != "$EXPECTED" ]]; then
  echo "ERROR: $ROLE admin authorization mismatch: configured signer does not match initialized on-chain admin. Review the identity and initialization parameters before publishing; do not retry production initialization blindly. No deployment metadata published." >&2
  exit 1
fi
echo "$ROLE admin verified against configured signer."
