#!/usr/bin/env bash
# Fail closed: do not create frontend configuration until GitHub provenance verifies.
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo 'Usage: verify_and_export_frontend.sh <manifest-json> <frontend-env-output>' >&2
  exit 2
fi
MANIFEST="$1"; OUTPUT="$2"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must identify the trusted origin repository}"
: "${GITHUB_SHA:?GITHUB_SHA is required for source revision verification}"
: "${GITHUB_REF:?GITHUB_REF is required for source ref verification}"
[[ "$GITHUB_REPOSITORY" == 'obajecollinsmicheal-cmd/smile4money' ]] || {
  echo 'ERROR: trusted deployment verification must run in the upstream repository.' >&2; exit 1;
}
[[ "$GITHUB_REF" == refs/heads/master ]] || {
  echo 'ERROR: deployment manifest must be from master.' >&2; exit 1;
}
command -v gh >/dev/null 2>&1 || { echo 'ERROR: GitHub CLI required for attestation verification.' >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo 'ERROR: Python 3 required for manifest validation.' >&2; exit 1; }
[[ -f "$MANIFEST" ]] || { echo 'ERROR: deployment manifest not found.' >&2; exit 1; }
# gh validates Sigstore signature, signed artifact digest, repository identity,
# workflow identity, source commit and source branch. No unverified data is exported.
if ! gh attestation verify "$MANIFEST" \
    --repo "$GITHUB_REPOSITORY" \
    --signer-workflow "$GITHUB_REPOSITORY/.github/workflows/deploy.yml" \
    --source-digest "$GITHUB_SHA" \
    --source-ref "$GITHUB_REF" >/dev/null; then
  echo 'ERROR: manifest attestation verification failed; frontend configuration NOT generated.' >&2
  exit 1
fi
python3 - "$MANIFEST" "$OUTPUT" "$GITHUB_SHA" <<'PY'
import json
from pathlib import Path
import re
import sys

source, destination, revision = sys.argv[1:]
try:
    doc = json.loads(Path(source).read_text(encoding="utf-8"))
    def require(condition):
        if not condition:
            raise ValueError("invalid attested data")

    require(doc["schema_version"] == 1)
    require(doc["source"]["revision"] == revision)
    require(doc["source"]["repository"] == "obajecollinsmicheal-cmd/smile4money")
    require(doc["admin_readback_verified"] is True)
    network = doc["network"]["name"]
    require(network == "testnet")
    rpc = doc["network"]["rpc_url"]
    require(rpc == "https://soroban-testnet.stellar.org")
    escrow = doc["contracts"]["escrow"]["id"]
    oracle = doc["contracts"]["oracle"]["id"]
    require(re.fullmatch(r"C[A-Z2-7]{55}", escrow))
    require(re.fullmatch(r"C[A-Z2-7]{55}", oracle))
    for role in ("escrow", "oracle"):
        require(re.fullmatch(r"[0-9a-f]{64}", doc["contracts"][role]["wasm_sha256"]))
    require(doc["contracts"]["escrow"]["initialization"]["admin"] == doc["contracts"]["oracle"]["initialization"]["admin"])
except (ValueError, KeyError, AssertionError, TypeError, OSError):
    print("ERROR: attested manifest schema or source revision invalid; no frontend configuration created.", file=sys.stderr)
    sys.exit(1)
# Only public information from a verified manifest goes into frontend config.
out = Path(destination)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(
    f"VITE_STELLAR_NETWORK={network}\n"
    f"VITE_STELLAR_RPC_URL={rpc}\n"
    f"CONTRACT_ESCROW={escrow}\n"
    f"CONTRACT_ORACLE={oracle}\n",
    encoding="utf-8",
)
print("Verified deployment manifest; frontend configuration prepared.")
PY
