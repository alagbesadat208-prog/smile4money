#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Deploys to testnet; validates admins and writes an unsigned local manifest.
exec bash "$SCRIPT_DIR/deploy_network.sh" testnet
