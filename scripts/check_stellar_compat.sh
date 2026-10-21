#!/usr/bin/env bash
# CLI/protocol guard for the contract toolchain. Safe to invoke before any mutation.
set -euo pipefail

fail() { printf 'Compatibility check failed: %s\n' "$1" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Keep declared support explicit; adjust only after testing the new toolchain.
SUPPORTED_CLI_MIN=22
SUPPORTED_CLI_MAX=27
CONTRACT_SDK_PROTOCOL=22

command -v stellar >/dev/null 2>&1 || fail 'Stellar CLI is missing.'
version="$(stellar --version 2>/dev/null || true)"
[[ "$version" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]] || fail 'Cannot determine stellar --version.'
major="${BASH_REMATCH[1]}"
if (( 10#$major < SUPPORTED_CLI_MIN || 10#$major > SUPPORTED_CLI_MAX )); then
  fail "Unsupported Stellar CLI major ${major}; supported ${SUPPORTED_CLI_MIN}-${SUPPORTED_CLI_MAX} for SDK/protocol ${CONTRACT_SDK_PROTOCOL}."
fi

if [[ "${1:-}" == '--network' ]]; then
  [[ "$#" -eq 2 ]] || fail 'Expected --network testnet|mainnet.'
  python3 "$SCRIPT_DIR/check_network_protocol.py" "$2" "${major#0}" || fail 'Read-only network protocol validation failed.'
  exit 0
fi

if [[ "${1:-}" == '--cli-only' ]]; then
  echo "Stellar CLI ${version} accepted for local tooling (supported ${SUPPORTED_CLI_MIN}-${SUPPORTED_CLI_MAX})."
  exit 0
fi

# Do not accept missing or undecodable contract metadata/spec, even if the CLI version matches.
[[ "$#" -eq 2 ]] || fail 'Pass both escrow.wasm and oracle.wasm, or --cli-only.'
for wasm in "$@"; do
  [[ -s "$wasm" ]] || fail "Missing or empty WASM artifact: $(basename "$wasm")"
  if ! stellar contract info env-meta --wasm "$wasm" >/dev/null 2>&1; then
    fail "CLI cannot decode the environment metadata in $(basename "$wasm")."
  fi
  if ! stellar contract info interface --wasm "$wasm" >/dev/null 2>&1; then
    fail "CLI cannot decode the contract interface in $(basename "$wasm")."
  fi
done

echo "Compatibility preflight passed: CLI ${version}; both contract WASM metadata and interfaces decoded."
