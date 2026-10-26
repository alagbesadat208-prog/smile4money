# Software Bill of Materials

Every release publishes a machine-readable [CycloneDX](https://cyclonedx.org) inventory of the direct and transitive components in each deployable artifact. Each inventory is cryptographically bound to the artifact and to how it was built (#103).

## What is produced

The `SBOM` workflow (`.github/workflows/sbom.yml`) runs when a GitHub release is published, and on demand from the Actions tab.

| Artifact | SBOM | Generated from |
|---|---|---|
| `escrow.wasm` | `smile4money-escrow.cdx.json` | `Cargo.lock`, by `cargo-cyclonedx` |
| `oracle.wasm` | `smile4money-oracle.cdx.json` | `Cargo.lock`, by `cargo-cyclonedx` |
| `backend-dist.tar.gz` | `backend.cdx.json` | `apps/backend/package-lock.json`, by `npm sbom` (production dependencies only) |
| `frontend-dist.tar.gz` | `frontend.cdx.json` | `apps/frontend/package-lock.json`, by `npm sbom` (production dependencies only) |

A CycloneDX BOM is also generated for each of the other workspace crates (leaderboard, contract registry, tournament bracket, shared common library). The workflow fails if any BOM is not valid CycloneDX or lists no components.

## Where to find it

- **On the release:** every `*.cdx.json` and the artifacts they describe are attached as release assets.
- **As a workflow artifact:** `sbom-<tag>`, kept for 90 days.
- **As attestations:** each artifact has a build-provenance attestation and an SBOM attestation with the same subject digest. Together they say how the file was built and what is inside it.

## Verifying a deployed artifact

```sh
# Was this file built by this repository's workflow, and what does it contain?
gh attestation verify escrow.wasm --repo obajecollinsmicheal-cmd/smile4money
gh attestation verify escrow.wasm --repo obajecollinsmicheal-cmd/smile4money \
  --predicate-type https://cyclonedx.org/bom
```

The second command prints the attested BOM. Compare its components with `smile4money-escrow.cdx.json` from the release.

## Using the inventory

- **Vulnerability triage.** Feed a BOM to a scanner that reads CycloneDX, for example `grype sbom:backend.cdx.json` or `osv-scanner --sbom=backend.cdx.json`, to check whether a deployed version contains an affected component.
- **Licence review.** Each component lists its declared licence.
- **Cross-check with policy.** The `Audit` workflow runs `cargo audit` on every change; the SBOM is the record of what a specific release actually shipped.

## Generating one locally

```sh
cargo install cargo-cyclonedx --locked --version 0.5
cargo cyclonedx --format json --spec-version 1.5      # one BOM per crate, next to its Cargo.toml
(cd apps/backend  && npm ci && npm sbom --sbom-format cyclonedx --omit dev > backend.cdx.json)
(cd apps/frontend && npm ci && npm sbom --sbom-format cyclonedx --omit dev > frontend.cdx.json)
```

`npm sbom` needs npm 10.2 or newer; Node 20 ships it.
