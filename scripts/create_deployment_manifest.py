#!/usr/bin/env python3
"""Build an unsigned local deployment record; CI attests it after successful deployment.

No secrets, environment dumps, seed phrases, or private keys are included.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def main() -> int:
    parser = argparse.ArgumentParser()
    for flag in ("network", "rpc-url", "network-passphrase", "escrow-id", "oracle-id",
                 "escrow-wasm", "oracle-wasm", "admin", "token", "safe-address"):
        parser.add_argument("--" + flag, required=True)
    args = parser.parse_args()
    if args.network not in ("testnet", "mainnet"):
        parser.error("network must be testnet or mainnet")
    for label, value, initial in (("escrow-id", args.escrow_id, "C"),
                                  ("oracle-id", args.oracle_id, "C"),
                                  ("admin", args.admin, "G"),
                                  ("token", args.token, "C"),
                                  ("safe-address", args.safe_address, "G")):
        if not re.fullmatch(re.escape(initial) + r"[A-Z2-7]{55}", value):
            parser.error(f"invalid {label}; expected a public Stellar address")
    try:
        revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    except (subprocess.CalledProcessError, OSError):
        parser.error("cannot determine source revision")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        parser.error("invalid source revision")

    def digest(path: str) -> str:
        hasher = hashlib.sha256()
        with open(path, "rb") as wasm:
            for chunk in iter(lambda: wasm.read(1024 * 1024), b""):
                hasher.update(chunk)
        return hasher.hexdigest()

    manifest = {
        "schema_version": 1,
        "source": {"revision": revision, "repository": os.environ.get("GITHUB_REPOSITORY", "obajecollinsmicheal-cmd/smile4money")},
        "network": {"name": args.network, "rpc_url": args.rpc_url, "passphrase": args.network_passphrase},
        "contracts": {
            "escrow": {"id": args.escrow_id, "wasm_sha256": digest(args.escrow_wasm),
                       "initialization": {"admin": args.admin, "oracle": args.oracle_id,
                                          "token": args.token, "safe_address": args.safe_address,
                                          "dispute_window_ledgers": None, "timeout_ledgers": None}},
            "oracle": {"id": args.oracle_id, "wasm_sha256": digest(args.oracle_wasm),
                       "initialization": {"admin": args.admin}},
        },
        "admin_readback_verified": True,
    }
    output = Path("deployments") / (args.network + ".json")
    output.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(manifest, sort_keys=True, indent=2) + "\n"
    tmp_name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent,
                                         prefix=".manifest-", delete=False) as out:
            tmp_name = out.name
            os.chmod(tmp_name, 0o600)
            out.write(serialized)
        os.replace(tmp_name, output)
    finally:
        if tmp_name and os.path.exists(tmp_name):
            os.unlink(tmp_name)
    print(f"Unsigned local manifest written to {output}; GitHub CI attestation required before frontend use.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
