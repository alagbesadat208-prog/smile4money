# Infrastructure — smile4money

**Document version:** 1.0  
**Date:** 2026-04-27  
**Status:** Active

---

## 1. Scope

This document defines the infrastructure scope for smile4money: a trustless chess wagering platform built on Stellar Soroban smart contracts. Infrastructure here covers everything outside the smart contract logic itself — CI/CD pipelines, deployment tooling, environment management, secrets handling, security scanning, and observability.

The scope is intentionally narrow for v1. The platform has no traditional backend servers or databases; the on-chain contracts and the off-chain Oracle service are the only runtime components. Infrastructure work therefore focuses on:

- Reliable, repeatable contract builds and deployments
- Automated quality gates on every code change
- Safe management of deployer keys and API credentials
- Visibility into deployed contract state and Oracle health

Out of scope for this document: frontend hosting, Oracle service runtime infrastructure (covered in `docs/oracle.md`), and smart contract logic.

---

## 2. Environments

Environments are defined in `environments.toml`. Four environments are recognized:

| Environment | Purpose | RPC URL |
|-------------|---------|---------|
| `standalone` | Local development, no external dependencies | `http://localhost:8000/soroban/rpc` |
| `testnet` | Integration testing, shared Stellar testnet | `https://soroban-testnet.stellar.org` |
| `futurenet` | Preview of upcoming Stellar features | `https://rpc-futurenet.stellar.org` |
| `mainnet` | Production | `https://soroban-mainnet.stellar.org` |

### Environment promotion path

```
standalone → testnet → (futurenet, optional) → mainnet
```

- All feature work is validated on `standalone` first.
- `testnet` is the integration gate before any mainnet consideration.
- `futurenet` is used only when testing against upcoming protocol changes.
- `mainnet` deployment requires a manual approval step (see §4.3).

### Environment variables

Each environment requires a `.env` file derived from `.env.example`. The file is never committed. Required variables:

```
STELLAR_NETWORK=<testnet|mainnet|...>
STELLAR_RPC_URL=<rpc endpoint>
STELLAR_RPC_POOL_SIZE=<maximum concurrent RPC sockets, default 10>
STELLAR_RPC_KEEP_ALIVE_TIMEOUT_MS=<keep-alive interval in milliseconds, default 5000>
CONTRACT_ESCROW=<deployed contract id>
CONTRACT_ORACLE=<deployed contract id>
LICHESS_API_TOKEN=<token>
CHESSDOTCOM_API_KEY=<key>
VITE_STELLAR_NETWORK=<testnet|mainnet>
VITE_STELLAR_RPC_URL=<rpc endpoint>
```

`CONTRACT_ESCROW` and `CONTRACT_ORACLE` are written automatically by the deploy scripts after a successful deployment.

---

## 3. CI Pipeline

**File:** `.github/workflows/ci.yml`  
**Trigger:** push to `master`, all pull requests targeting `master`  
**Rust toolchain:** 1.81.0 (pinned in `rust-toolchain.toml`)

### Jobs

| Job | Command | Failure policy |
|-----|---------|----------------|
| `test` | `cargo test --lib` + `cargo test --doc` | Blocks merge |
| `clippy` | `cargo clippy --all-targets --all-features -- -D warnings` | Blocks merge |
| `fmt` | `cargo fmt -- --check` | Blocks merge |
| `build` | `cargo build --release --target wasm32-unknown-unknown` | Blocks merge |

All jobs run in parallel. Cargo dependencies are cached keyed on `Cargo.lock` to keep run times short.

### Standards

- All four jobs must pass before a PR can be merged.
- Clippy warnings are treated as errors (`-D warnings`). No `#[allow(...)]` suppressions without a comment explaining why.
- Formatting is enforced by `rustfmt`. Run `cargo fmt` locally before pushing.
- The WASM build job confirms the contracts compile for the target architecture, not just the host.

---

## 4. Deployment

### 4.1 Testnet deployment

**File:** `.github/workflows/deploy.yml`  
**Trigger:** push to `master` when files under `contracts/` change, or manual `workflow_dispatch`  
**GitHub environment:** `testnet` (requires `DEPLOYER_SECRET_KEY` secret)

The workflow:
1. Builds WASM artifacts.
2. Installs Stellar CLI v22.0.1 (pinned).
3. Imports the deployer identity from `DEPLOYER_SECRET_KEY`.
4. Runs `./scripts/deploy_testnet.sh`.
5. Uploads the resulting `.env` (containing contract IDs) as a workflow artifact.

The deploy script (`scripts/deploy_testnet.sh`) does the following in order:
1. Verifies `stellar` CLI is available and the `deployer` identity exists.
2. Funds the deployer via Friendbot (no-op if already funded).
3. Builds both contracts.
4. Deploys escrow and oracle contracts.
5. Initializes oracle (admin = deployer address).
6. Initializes escrow (oracle = oracle contract address, admin = deployer address).
7. Writes `CONTRACT_ESCROW` and `CONTRACT_ORACLE` to `.env`.

### 4.2 Mainnet deployment

No automated mainnet deployment workflow exists yet. Before creating one:

- A separate `mainnet` GitHub environment must be configured with its own `DEPLOYER_SECRET_KEY` secret and required reviewers.
- The deploy script must be parameterized to accept a `NETWORK` argument (or a separate `deploy_mainnet.sh` created).
- Mainnet deployment must be `workflow_dispatch` only — never triggered automatically on push.
- Contract IDs written after mainnet deployment must be stored durably (e.g., as a GitHub release artifact or in a dedicated config file committed to the repo).

### 4.3 Deployment checklist (pre-mainnet)

Before any mainnet deployment:

- [ ] All CI jobs pass on the commit being deployed.
- [ ] Security audit (`cargo audit`) shows no unresolved advisories.
- [ ] Contracts have been live on testnet for at least one full test cycle.
- [ ] Deployer key is a dedicated key, not a personal key.
- [ ] `DEPLOYER_SECRET_KEY` is stored only in GitHub Secrets, not in any file.
- [ ] Contract IDs are recorded and communicated to the team.

---

## 5. Security Scanning

**File:** `.github/workflows/audit.yml`  
**Trigger:** push to `master`, all PRs, weekly schedule (Monday 06:00 UTC)  
**Tool:** `cargo-audit` v0.21.0 (pinned)

`cargo audit` checks all dependencies in `Cargo.lock` against the RustSec advisory database. Any known vulnerability in a dependency fails the job.

### Standards

- Audit failures block merges on PRs.
- Weekly scheduled runs catch new advisories against unchanged code.
- When an advisory is reported: assess severity, update the affected dependency if a fix is available, or add a justified `ignore` entry in `audit.toml` if the advisory does not apply to this project's usage.

---

## 6. Secrets Management

All secrets are managed through GitHub Actions Secrets. No secret values are ever committed to the repository.

| Secret | Scope | Used by |
|--------|-------|---------|
| `DEPLOYER_SECRET_KEY` | `testnet` environment | `deploy.yml` — imports deployer identity |
| `LICHESS_API_TOKEN` | Runtime (Oracle service) | Oracle service `.env` |
| `CHESSDOTCOM_API_KEY` | Runtime (Oracle service) | Oracle service `.env` |

### Rules

- Secrets are scoped to the minimum required environment (testnet vs. mainnet).
- Deployer keys for testnet and mainnet are separate keys.
- Secret rotation: rotate `DEPLOYER_SECRET_KEY` if the key is ever exposed or a team member with access leaves.
- Never log secret values in workflow steps. The `stellar keys add` step uses `env:` injection, not shell interpolation, to avoid leaking the key in process listings.

---

## 7. Toolchain and Dependency Pinning

| Tool | Pinned version | Location |
|------|---------------|----------|
| Rust | 1.81.0 | `rust-toolchain.toml`, all workflow files |
| WASM target | `wasm32-unknown-unknown` | `rust-toolchain.toml` |
| Stellar CLI | v22.0.1 | `deploy.yml` install step |
| `cargo-audit` | 0.21.0 | `audit.yml` install step |

### Standards

- Toolchain versions are pinned, not floating. Update them deliberately with a dedicated PR.
- `Cargo.lock` is committed and kept up to date. Do not add `Cargo.lock` to `.gitignore`.
- When updating a dependency, run the full CI suite locally before pushing.

---

## 8. Observability

Settlement age monitoring is available (see 8.1). Contract event indexing and Oracle uptime monitoring are not yet configured; this is acceptable for testnet but must be addressed before mainnet launch.

### Planned work (pre-mainnet)

- **Contract event indexing:** Set up a Stellar Horizon or custom event listener to index `match.created`, `match.completed`, `match.cancelled`, and `oracle.result` events. These events are already emitted by the contracts.
- **Oracle health check:** The Oracle service should expose a `/health` endpoint. A simple uptime monitor (e.g., GitHub Actions scheduled ping, or an external service) should alert if the Oracle goes down.
- **Deployment verification:** After each deploy, run a smoke test that calls `get_match` on a known match ID (or creates a test match) to confirm the deployed contract is responsive.

### 8.1 Settlement age monitoring

A process can be healthy while active matches silently wait too long for a game result or for the chain. The settlement age monitor (`apps/backend/src/services/settlement-age-monitor.ts`) records when each match reaches each stage and publishes age percentiles and threshold alerts. It is **observability only**: it records timestamps, logs metrics and raises alerts. It never changes what is submitted and never reverses or settles anything.

**Stages** (the first timestamp recorded for a match wins):

| Stage | Recorded when |
|-------|---------------|
| `activated` | The backend starts tracking the match (its polling job was created). Synced from the polling store on every publish tick. |
| `provider_result` | The chess platform reported a final result (`onGameCompleted`). |
| `submission_started` | The first attempt to put the result on-chain begins. |
| `chain_confirmed` | The result is confirmed on-chain (the submission handler succeeded, or the result already existed). |

**Segments.** Each segment is measured and alerted on separately, so a slow chess platform is never confused with a slow chain submission:

| Segment | From | To | Default threshold |
|---------|------|----|-------------------|
| `provider_wait` | `activated` | `provider_result` | 24 hours |
| `submission_lag` | `provider_result` | `submission_started` | 10 minutes |
| `chain_delay` | `submission_started` | `chain_confirmed` | 15 minutes |
| `total` | `activated` | `chain_confirmed` | 48 hours |

`chain_delay` includes retry back-off, because it runs from the first submission attempt until confirmation.

**Published metrics.** Every publish interval (default 60 seconds) one structured log line is written: message `settlement_age_metrics`, field `metric: "settlement_age"`. It contains:

- `completed.<segment>`: count, p50, p90, p95, p99 and max (ms) over the most recent completed matches (default window 200).
- `open.<segment>`: the same percentiles for matches still waiting, measured from when they entered the segment they are currently in, plus `overThreshold` and `stuckMatchIds`.
- `openMatches`, `completedInWindow`, `abandoned`, `evicted`, `alerts` and the active `thresholds`.

Set `HEALTH_INCLUDE_SETTLEMENT=true` to also return the same snapshot as `settlement` from the `/health` endpoint.

**Alerts.**

| Alert id | Raised when |
|----------|-------------|
| `<segment>_stuck` | At least one waiting match is older than the segment threshold. Carries the count, the oldest age and up to 5 match ids. |
| `<segment>_slow_p95` | The p95 of recently completed matches is above the threshold (needs at least `SETTLEMENT_AGE_MIN_SAMPLES` samples). |

Each alert is logged once when raised (`settlement_age_alert_raised`, level error) and once when it clears (`settlement_age_alert_cleared`, level info), not once per tick.

**Reading the alerts.**

- `provider_wait_*`: the game is not finished or the chess platform is not answering. Check the platform status pages in the contact list (section 7 of the runbook) and the polling logs.
- `submission_lag_*`: the game finished but the backend has not started submitting. Check that the submission pipeline and retry worker are running.
- `chain_delay_*`: a submission was started but is not confirmed. Check Stellar RPC health, the circuit breaker state and `oracle_dlq_depth`.
- `total_*`: a match is old overall. Use the other alerts to find which segment it is stuck in.

**Configuration** (invalid values stop the server at startup):

| Environment variable | Default |
|----------------------|---------|
| `SETTLEMENT_AGE_MONITOR_ENABLED` | `true` |
| `SETTLEMENT_AGE_PUBLISH_INTERVAL_MS` | 60000 |
| `SETTLEMENT_AGE_PROVIDER_WAIT_MS` | 86400000 |
| `SETTLEMENT_AGE_SUBMISSION_LAG_MS` | 600000 |
| `SETTLEMENT_AGE_CHAIN_DELAY_MS` | 900000 |
| `SETTLEMENT_AGE_TOTAL_MS` | 172800000 |
| `SETTLEMENT_AGE_COMPLETED_WINDOW` | 200 |
| `SETTLEMENT_AGE_MIN_SAMPLES` | 5 |
| `SETTLEMENT_AGE_MAX_TRACKED` | 10000 |
| `HEALTH_INCLUDE_SETTLEMENT` | `false` |

Matches that time out or are moved to the dead-letter queue are dropped from tracking and counted in `abandoned`, so they stop aging.

---

## 9. Local Development Setup

```bash
# 1. Install Rust with the correct toolchain
rustup toolchain install 1.81.0
rustup target add wasm32-unknown-unknown

# 2. Install Stellar CLI
# See: https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli

# 3. Copy environment file
cp .env.example .env

# 4. Build contracts
./scripts/build.sh

# 5. Run tests
./scripts/test.sh

# 6. Deploy to testnet (requires a funded deployer identity)
stellar keys generate deployer --network testnet
./scripts/deploy_testnet.sh
```

For standalone (local) development, start a local Stellar node and set `STELLAR_NETWORK=standalone` in `.env`.

---

## 10. Outstanding Infrastructure Tasks

These items are not yet implemented and represent the next infrastructure work to be done:

| Priority | Task | Notes |
|----------|------|-------|
| High | Mainnet deploy workflow | `workflow_dispatch` only, separate environment, required reviewers |
| High | Deployment smoke test | Post-deploy script that invokes a read-only contract function to verify liveness |
| Medium | Contract event indexer | Index on-chain events for frontend and monitoring use |
| Medium | Oracle health monitoring | Uptime check with alerting |
| Medium | `audit.toml` baseline | Document any intentional advisory ignores |
| Low | Futurenet workflow | Optional; only needed when testing against upcoming protocol changes |

---

## 11. File Reference

| Path | Purpose |
|------|---------|
| `.github/workflows/ci.yml` | CI — test, clippy, fmt, build |
| `.github/workflows/deploy.yml` | Automated testnet deployment |
| `.github/workflows/audit.yml` | Weekly + PR security audit |
| `scripts/deploy_testnet.sh` | Testnet build + deploy + init script |
| `scripts/build.sh` | Local build script |
| `scripts/test.sh` | Local test script |
| `environments.toml` | Network RPC URLs and passphrases |
| `.env.example` | Template for environment variables |
| `rust-toolchain.toml` | Pinned Rust toolchain |

### SQLite production concurrency

SQLite supports **one backend process in one replica**, with database files on a
local persistent volume. Each connection uses WAL journal mode and a busy timeout
of 5,000 ms; existing bounded lock retries remain enabled. Concurrent requests
within that process are supported; SQLite serializes their writes. WAL permits
readers alongside the single active writer. Do not place these files on a network
filesystem or share them across containers/hosts.

Set `SQLITE_CONCURRENCY_MODE=single-process` (the default), `BACKEND_REPLICAS=1`,
and `WEB_CONCURRENCY=1`. Startup rejects another mode or a declared process/replica
count other than one, for every SQLite store. Set `SQLITE_BUSY_TIMEOUT_MS` to an
integer from 1 through 60,000 to change the per-connection wait. Deployment
manifests must declare the real replica/worker counts: the service cannot discover
undeclared replicas. This restriction covers matches, rate limits, queue, and
circuit-breaker state, even if `QUEUE_STORE` uses another backend. Scaling requires
migrating all local stores and coordinating workers first.

### Oracle signer rotation

Mount the current Stellar secret seed in a secret-manager-owned file and set
`ORACLE_SIGNER_SECRET_FILE` to its path. Restrict file access to the service user.
Set `STELLAR_RPC_URL` and `CONTRACT_ORACLE` for the deployed oracle. The service
loads the seed at startup and before each submission attempt, then reads the
contract's active `InstanceState.admin` from RPC and compares it to the public
key. Missing, malformed, unauthorized keys or an unavailable role lookup fail
closed before submission. A pending admin proposal is insufficient.

Complete the contract's `propose_admin` / `accept_admin` transfer and atomically
replace the mounted secret file with the new seed. Pause workers during the
transfer if uninterrupted attempts matter; failures in the transition leave jobs
queued. Restarting is unnecessary for a running worker to pick up the file.
Jobs contain submission data only, never a seed or signer address; do not rewrite
or discard pending jobs. The retry worker removes a job only after its handler
succeeds and does not create a replacement job on failure.

The transport prepares `submit_result` with Soroban RPC, signs with that attempt's
validated key, and confirms the transaction before removing the job. On an
ambiguous timeout the job stays queued; the next attempt queries `has_result`
before submitting again. Set `STELLAR_NETWORK=testnet` (default) or `mainnet`, or
provide `STELLAR_NETWORK_PASSPHRASE` explicitly for a custom network. The source
account must be funded, and the deployed contract must use the current oracle
`InstanceState` storage layout.
