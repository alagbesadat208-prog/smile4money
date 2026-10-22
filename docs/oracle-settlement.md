# Durable oracle settlement

The backend requires `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`,
`CONTRACT_ESCROW`, and `ORACLE_SECRET_KEY`. The signing account must be funded
and must be the escrow's configured oracle. The exact network passphrase is
mandatory. HTTP RPC is accepted only on loopback for local development.

Run one backend worker per escrow/signing account. The HTTP handler and worker
serialize transaction construction and confirmation; an outstanding signed
transaction blocks allocating the next account sequence. Multiple independent
workers sharing a signing account are unsupported.

The reconciliation source is the persisted match registration table plus escrow's
`get_match`. Every polling cycle (including the first cycle after restart) checks
registrations against their on-chain ID, game ID, player addresses, and platform.
Only `Active` matches are eligible. Both deposits must therefore have confirmed
on-chain; storing a `Pending` registration alone does not activate monitoring.
The registration's ID must match the contract's ID. Mismatches fail closed and
are logged as `oracle_reconciliation_failed` for operator correction. External
chain matches without a persisted player-identity registration are not monitored.

SQLite's unique `(network + contract, match ID, game ID)` key deduplicates enqueue,
including terminal records. Mount both the match database and settlement database
on persistent storage. `SETTLEMENT_DB_PATH` optionally overrides the outbox path.
The outbox uses WAL and FULL synchronous writes and has no TTL eviction.

The lifecycle is `active → pending → submitted → confirmed`, with `quarantined`
for explicit review. The worker verifies the external game, player identities,
and stored identity hash before persisting the completed outcome as `pending`.
White/black outcomes are mapped to the registered player addresses. A pending
outcome is never fetched again, even after a process restart or API outage.
Preparation or submission failure retains it and schedules exponential backoff.
After 1440 failures before a transaction is prepared, it is quarantined.

Settlement calls escrow's `submit_result(match_id, game_id, winner, caller)`.
This starts escrow's dispute window (`PendingResult`); finalizing the payout
remains subject to that contract's dispute policy. Writing to the separate
oracle registry alone would not transition escrow and is not used here.

Before broadcast, the backend commits the signed envelope, its locally calculated
hash, and expiry to SQLite. It queries `getTransaction(hash)` before every send.
A missing transaction can only rebroadcast the **same signed bytes**, preserving
its hash and sequence number. A timeout never causes an automatic replacement
transaction. `SUCCESS` confirms the outbox record; `FAILED` quarantines it. An
expired transaction with unknown status is quarantined with its hash and result
retained. This also covers prolonged outages or RPC history pruning.

`POST /api/oracle/submit-result` verifies and durably submits through this same
pipeline. The response includes `transactionHash`, `chainStatus`, and
`settlementState`: HTTP 200 for confirmed, 202 for pending confirmation, or 409
for quarantined. The worker retries automatically; repeating the authenticated
request also reconciles the same transaction. Missing runtime configuration
fails startup; an app without a configured worker returns 503 instead of claiming
a verified result was submitted.

For manual recovery, stop the backend, back up the outbox, inspect the record's
error/hash, query that hash and the escrow match on the configured network, and
resolve the cause before modifying a quarantined record. Do not clear a hash or
construct another transaction while its outcome is uncertain. Legacy DLQ entries
have no signed envelope/hash and require manual review; automatic blind legacy
retries are disabled. The existing legacy DLQ retention policy is separate from
the outbox; archive old entries before their configured eviction deadline.

## Verification

From the repository root:

```sh
npm --prefix apps/backend ci
VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 npm --prefix apps/backend test -- tests/durable-settlement.test.ts tests/polling.test.ts tests/oracle-submit.test.ts tests/oracle-route.test.ts tests/game-poller.test.ts tests/services/oracle-service.test.ts
rustup target add wasm32v1-none
cargo build --locked --release --target wasm32v1-none -p smile4money-escrow
wasm-opt -Oz target/wasm32v1-none/release/smile4money_escrow.wasm -o target/wasm32v1-none/release/smile4money_escrow.optimized.wasm
docker run -d --name smile4money-oracle-local -p 18000:8000 stellar/quickstart:v499-latest --local --enable-soroban-rpc
# Wait for the local RPC getHealth endpoint to report healthy.
RUN_LOCAL_SOROBAN=1 npm --prefix apps/backend test -- tests/integration/oracle-settlement.local.test.ts
docker stop smile4money-oracle-local
docker rm smile4money-oracle-local
```

`wasm-opt` is provided by Binaryen and keeps the upload below the local
network transaction size limit.

The local integration deploys the repository's escrow WASM and native asset
contract, funds fresh accounts, creates a registered match, approves and deposits
both stakes, submits through the authenticated HTTP endpoint, and asserts the
returned hash has `SUCCESS` status and escrow is `PendingResult`. Only the
external chess API is mocked. It runs against a local network, never testnet or
mainnet. Override `LOCAL_SOROBAN_RPC_URL`, `LOCAL_FRIENDBOT_URL`, or
`ESCROW_WASM_PATH` if needed. Without `RUN_LOCAL_SOROBAN=1` this test is skipped.

Building that escrow required repairing pre-existing compile errors: duplicate
pause/unpause definitions, a duplicate error discriminant, zero-address
construction, a deposit event variable's scope, and checked `u128` → `i128`
conversions at the token boundary. The stored stake type remains `u128`.
`DisputeWindowExpired` now has the distinct error code 34. The lockfile includes
previously missing workspace/development dependencies without upgrading existing
locked packages.
