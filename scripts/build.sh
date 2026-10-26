#!/usr/bin/env bash
set -euo pipefail

# Use pinned Docker image for reproducible builds
DOCKER_IMAGE="stellar/soroban-rust:21.0.0"

PROFILE="--release"
if [[ "${1:-}" == "--debug" ]]; then
  PROFILE=""
fi

bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check_stellar_compat.sh" --cli-only

echo "Building Soroban contracts${PROFILE:+ (release)}..."
echo "Using pinned Docker image: $DOCKER_IMAGE"

# Build in Docker for reproducibility
if ! docker run --rm -v "$(pwd):/workspace" -w /workspace "$DOCKER_IMAGE" cargo build --target wasm32-unknown-unknown $PROFILE; then
  echo "Error: cargo build failed." >&2
  exit 1
fi

bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check_stellar_compat.sh" target/wasm32-unknown-unknown/release/escrow.wasm target/wasm32-unknown-unknown/release/oracle.wasm
echo "Build complete."
