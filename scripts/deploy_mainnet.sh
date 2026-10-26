#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Mainnet spends real XLM and requires an explicit operator confirmation.
exec bash "$SCRIPT_DIR/deploy_network.sh" mainnet
