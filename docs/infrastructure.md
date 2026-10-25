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

Which **combinations** of protocol, SDK and wallet are supported, and how upgrades are tested
ahead of time, is defined in [compatibility.md](compatibility.md). The CI **Compatibility Matrix**
job fails if any pin below drifts from it.

| Tool | Pinned version | Location |
|------|---------------|----------|
| Rust | 1.88.0 | `rust-toolchain.toml`, all workflow files |
| soroban-sdk | 22.0.11 | `Cargo.toml` `[workspace.dependencies]` |
| @stellar/stellar-sdk | 16.0.1 | `apps/backend/package.json`, `apps/frontend/package.json` |
| WASM target | `wasm32-unknown-unknown` | `rust-toolchain.toml` |
| Stellar CLI | v22.0.1 | `deploy.yml` install step |
| `cargo-audit` | 0.21.0 | `audit.yml` install step |

### Standards

- Toolchain versions are pinned, not floating. Update them deliberately with a dedicated PR.
- `Cargo.lock` is committed and kept up to date. Do not add `Cargo.lock` to `.gitignore`.
- When updating a dependency, run the full CI suite locally before pushing.

---

## 8. Observability

No monitoring or alerting is currently configured. This is acceptable for testnet but must be addressed before mainnet launch.

### Planned work (pre-mainnet)

- **Contract event indexing:** Set up a Stellar Horizon or custom event listener to index `match.created`, `match.completed`, `match.cancelled`, and `oracle.result` events. These events are already emitted by the contracts.
- **Oracle health check:** The Oracle service should expose a `/health` endpoint. A simple uptime monitor (e.g., GitHub Actions scheduled ping, or an external service) should alert if the Oracle goes down.
- **Deployment verification:** After each deploy, run a smoke test that calls `get_match` on a known match ID (or creates a test match) to confirm the deployed contract is responsive.

### 8.1 Trace context propagation

The backend follows [W3C Trace Context](https://www.w3.org/TR/trace-context/) so one trace id
follows a match from the HTTP request that started it, through durable queue work, to the
provider and Stellar RPC calls that work makes, including retries hours later and after a
restart.

| Hop | How the trace continues | Code |
|-----|-------------------------|------|
| Browser → API | The frontend sends a fresh `traceparent` on backend calls (never to Horizon or other third parties) | `apps/frontend/src/utils/trace-context.ts` |
| API request | `traceContext()` middleware continues a valid incoming `traceparent` (or starts a trace) and echoes the server span in the `traceparent` response header | `apps/backend/src/middleware/trace-context.ts` |
| Logs | Every structured log line inside a context carries `trace_id`, `span_id` and `parent_span_id` | `apps/backend/src/logger.ts`, `apps/backend/src/queue.ts` |
| Polling job | `PollingJobStore.createJob` stores the creating request's context; each poll runs as a child span of it | `apps/backend/src/services/polling.ts` |
| Oracle DLQ | `writeToDlq` stores `{ traceparent, tracestate }` with the entry (SQLite column `traceContext`, Mongo field, in-memory). Each retry resumes it as a new child span under the original trace id | `apps/backend/src/queue.ts`, `apps/backend/src/store/*-queue-store.ts` |
| Provider calls | Lichess and Chess.com requests send `traceparent`/`tracestate` | `apps/backend/src/fetchers/*.ts` |
| Stellar RPC | An axios interceptor on the shared RPC client adds the headers | `apps/backend/src/services/stellar.ts` |

**Finding a trace.** Take the `traceparent` from the API response (or the `trace_id` on any log line), then
filter logs on `trace_id`. DLQ retries keep the trace id and show as sibling spans with the same
`parent_span_id`.

**Older entries.** DLQ rows written before this existed have no stored context (the SQLite column
is added on startup). They, and any row whose stored value is corrupt, get a fresh trace on retry
rather than failing.

**What a trace may contain.** Random trace and span ids, the sampling flag, and a sanitised
`tracestate`. Nothing else: no request bodies, wallet addresses, Stellar secret keys, JWTs or
provider tokens. `tracestate` is the only client-controlled field, so `sanitizeTraceState` drops
any member that is malformed, has a credential-like key (`token`, `secret`, `auth`, `apikey`, …), or
holds a Stellar secret seed, a JWT or a Lichess token, and enforces the spec's 32-member and
512-character limits. `tests/tracing/trace-context.test.ts` sends a hostile `tracestate` and asserts
that none of those values reach the stored entry, the logs or outbound headers. The provider API
token is only ever sent in `Authorization`.

**Exporting spans.** This is propagation only; nothing is exported yet. An OpenTelemetry collector
that reads `traceparent` (or a log pipeline grouping on `trace_id`) can stitch the hops together.
Adding an exporter later needs no change to what is persisted.

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
| `compatibility-matrix.json` | Supported and candidate version combinations ([compatibility.md](compatibility.md)) |
| `.github/workflows/compatibility.yml` | Weekly/on-demand compatibility build of every combination |
