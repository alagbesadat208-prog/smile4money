# Deployment authorization and provenance (#1956, #1957)

## Before deployment

This project uses the existing `deployer` Stellar identity for both the Soroban transaction signer and the initial contract administrator. Do not use an unrelated key to initialize either role. Configure the two **public** escrow inputs before running a deployment:

```bash
export ESCROW_TOKEN_ADDRESS="<C... token contract StrKey>"
export ESCROW_SAFE_ADDRESS="<G... emergency safe account StrKey>"
```

On GitHub Actions, use the `testnet` environment's non-secret repository variables `TESTNET_ESCROW_TOKEN_ADDRESS` and `TESTNET_ESCROW_SAFE_ADDRESS`, and the existing secret `DEPLOYER_SECRET_KEY`. The safe address must be operator-verified; the deployment script will not silently choose one. Mainnet requires an explicit `yes` confirmation and consumes real XLM; do not use it as a test command.

## Admin readback

The read-only `get_admin()` contract getters expose the active admin without signing or changing state. After initialization, `scripts/verify_admin_readback.sh` reads each contract using the configured RPC and compares the returned public address to `stellar keys address deployer`. An unsuccessful read or mismatch fails the deployment before any `.env` update or manifest creation. The error intentionally omits the actual addresses and RPC response body. No deployed funds or contracts can be automatically rolled back if a check fails; review the contract IDs out of band before retrying.

## Source-bound manifest

The deployment script generates a local, **unsigned** JSON record in `deployments/testnet.json` or `deployments/mainnet.json`, containing source Git SHA, network and passphrase, deployed contract IDs, SHA-256 WASM hashes, and initialization parameters. It is not trusted solely because it exists. It intentionally does not contain private keys, user secrets, or a copy of `.env`.

GitHub's trusted `master` deployment workflow uses `actions/attest@v4` to sign a provenance statement for the exact manifest digest. It then uses `gh attestation verify` with the expected repository, signer workflow, branch and source commit before generating `apps/frontend/.env.deployment`. Only then does CI upload the public `verified-deployment` artifact. **Do not upload or consume `.env` from a workflow artifact**, since it can contain credentials. Downloading an artifact outside the trusted CI workflow requires independently verifying its attestation again before consuming it, e.g.:

```bash
gh attestation verify deployments/testnet.json \
  --repo obajecollinsmicheal-cmd/smile4money \
  --signer-workflow obajecollinsmicheal-cmd/smile4money/.github/workflows/deploy.yml
```

This only authenticates build provenance and the exact manifest bytes. It does not prove the frontend has already been deployed, that a contract is free of bugs, or that an admin can authorize every action after subsequent role rotation. Local mainnet manifests are **not signed by this testnet CI workflow** and must not be treated as trusted artifacts without a separate trusted mainnet signing and verification pipeline.
