# Contributing to smile4money

Thank you for your interest in contributing. This guide covers everything you need to get started.

## Prerequisites

- **Rust** 1.70+ with the `wasm32-unknown-unknown` target
- **Stellar CLI** — [install guide](https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli)
- **Git**

Install the WASM target if you haven't already:

```bash
rustup target add wasm32-unknown-unknown
```

## Local Setup

```bash
git clone https://github.com/obajecollinsmicheal-cmd/smile4money.git
cd smile4money
cp .env.example .env
```

## Build

```bash
./scripts/build.sh
# or directly:
cargo build --target wasm32-unknown-unknown --release
```

## Test

```bash
./scripts/test.sh
# or directly:
cargo test
```

Run formatters and clippy before opening a PR:

```bash
cargo fmt --all
cargo fmt --all --check
cargo clippy -- -D warnings

cd apps/frontend
npm ci
npm run format
npm run format:check

cd ../backend
npm ci
npm run format
npm run format:check
```

## Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Bug fix | `fix/issue-<N>-short-description` | `fix/issue-1-double-initialize` |
| New test | `test/issue-<N>-short-description` | `test/issue-21-unauthorized-deposit` |
| Documentation | `docs/issue-<N>-short-description` | `docs/issue-104-contributing-guide` |
| Feature | `feat/issue-<N>-short-description` | `feat/issue-17-update-oracle` |

Always branch off `master`:

```bash
git checkout master
git pull
git checkout -b fix/issue-<N>-short-description
```

## Commit Style

Use the conventional commits format:

```
<type>: <short summary>
```

Common types: `fix`, `feat`, `test`, `docs`, `refactor`, `chore`.

Examples:
```
fix: guard initialize against double-call
test: add unauthorized deposit test for issue #21
docs: add contributing guide
```

## Opening a Pull Request

1. Push your branch and open a PR against `master`.
2. Link the issue in the PR body using `Closes #<N>`.
3. Keep the PR title under 70 characters.
4. Ensure `cargo test`, `cargo fmt --all --check`, and `cargo clippy -- -D warnings` pass — CI will check all of them.
5. Ensure `npm run format:check` passes in both `apps/frontend` and `apps/backend`.
6. Add a brief description of what changed and how it was tested.

## Branch Protection Rules

The `master` branch is protected. The following rules apply to all pull requests:

### Required Status Checks

Every PR must pass these CI jobs before it can be merged:

| Check | CI job |
|-------|--------|
| Escrow unit & doc tests | `Escrow Tests` |
| Oracle unit & doc tests | `Oracle Tests` |
| Code coverage ≥ 80 % | `Coverage` |
| Clippy (zero warnings) | `Clippy` |
| Rust formatting | `Format` |
| Prettier (frontend) | `Prettier` |
| WASM build | `Build` |
| environments.toml validation | `Validate environments.toml` |
| Frontend type-check / lint / tests | `Frontend` |
| Backend build (type-check) / tests | `Backend` |

### Required Reviewers

At least **1 approving review** from a maintainer is required. Changes to production-sensitive paths also need a code-owner approval; see [Production Configuration Changes](#production-configuration-changes).

### Merge Policy

- **Squash merge only** — keeps history linear.
- **No direct pushes** to `master` — always open a PR.
- Branches must be **up to date** with `master` before the merge button is enabled.

### Production Configuration Changes

Some paths change production behavior directly: RPC endpoints and network selection, contract IDs, token addresses, contract code, and the deploy pipeline. Each one has a domain owner in [`.github/CODEOWNERS`](../.github/CODEOWNERS):

| Area | Paths |
|------|-------|
| Network, RPC endpoints, contract IDs, token addresses | `environments.toml`, `.env.example`, `apps/backend/src/config/`, `apps/backend/src/services/stellar.ts`, `apps/frontend/src/constants.ts`, `apps/frontend/src/main.tsx` |
| Smart contracts | `contracts/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` |
| Deployment policy and pipeline | `.github/workflows/`, `scripts/deploy_*.sh`, `scripts/verify_wasm_hash.sh`, `scripts/validate_environments.py`, `scripts/check-secrets.sh`, `docs/deployment.md`, `docs/runbook.md` |
| Supply-chain policy | `deny.toml`, `audit.toml`, `.github/dependabot.yml` |

**Rules for a PR that touches any of these paths:**

1. **Code-owner approval is required.** Enable **Require review from Code Owners** in the `master` branch protection (Settings → Branches → `master`), in addition to the one maintainer approval above. GitHub then blocks the merge until an owner of every touched path approves.
2. **The author cannot be the only owner who approves.** If the author is the sole owner of a path, another maintainer must review before merging.
3. **State the production effect in the PR body.** Say which networks are affected (testnet, mainnet), the old and new values for any endpoint, contract ID or token address, and how the change was verified (for example `scripts/validate_environments.py`, or a testnet deploy and its transaction hash).
4. **No bundling.** Keep a production-config change in its own PR, not mixed into a feature PR, so the review is about the config alone.
5. **Mainnet IDs are checked against the deploy run.** A mainnet contract ID must match the one printed in the **Deployment summary** step of the `Deploy to Mainnet` workflow run that deployed it; link that run in the PR. A token address must be checked against the issuer's published contract address.

### Emergency Override

During an active incident (see [`docs/runbook.md`](runbook.md)), a repository admin may merge a production-config change without the normal code-owner approval, for example to point the apps at a working RPC endpoint or to ship a pause-related fix. An override must be:

1. **Necessary.** Waiting for a code owner would prolong user impact or put funds at risk.
2. **Minimal.** Only the change the incident needs, nothing else.
3. **Recorded at the time.** The PR body starts with `EMERGENCY OVERRIDE:`, names the incident, and says why the normal review could not wait. Use the **Bypass branch protections** option; do not disable protection for the repository.
4. **Reviewed afterwards.** A code owner reviews the merged change within **one business day** and either approves it in a comment on the PR or opens a follow-up PR to revert or amend it.

### Audit Requirements

- **Every override is listed** in the incident's post-incident report ([runbook §6](runbook.md#6-post-incident-report-template)) with the PR link, who merged it, and the follow-up review outcome.
- **Settings changes are audited too.** Changes to branch protection or to `CODEOWNERS` itself are production-config changes and follow the same rules. The repository audit log (Settings → Audit log) is the record for protection-rule changes; check it after every incident.
- **Quarterly check.** A maintainer confirms each quarter that "Require review from Code Owners" is still enabled on `master`, that every owner in `CODEOWNERS` still has write access, and that every override since the last check had its follow-up review.

### Setting Up Protections on a Fork

Refer to the [GitHub branch protection documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) to mirror these rules on your fork.

---

## Reporting Issues

Open a GitHub issue with:
- A clear title matching the category (`Fix:`, `Test:`, `Doc:`, etc.)
- Steps to reproduce (for bugs)
- Expected vs actual behaviour

For security vulnerabilities, add the `security` label and contact the maintainers before public disclosure.
