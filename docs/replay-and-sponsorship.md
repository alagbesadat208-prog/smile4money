# Settlement replay and wager navigation

The Vite entry point mounts App once. App owns the theme, wallet, toast, error
boundary, and router. The primary navigation exposes `/create-match`, `/deposit`,
`/matches`, `/matches/:matchId`, `/matches/:matchId/deposit`, `/history`, and
`/leaderboard`. Create submits a prepared escrow call and navigates to the returned
on-chain match ID. Deposit waits for ledger success. A connected wallet supplies
the simulation source for deposit and match detail reads. Configure
`VITE_ESCROW_CONTRACT_ID` and, for USDC, `VITE_USDC_CONTRACT_ID` with contracts on
the wallet's network. Serve the Vite build with an SPA fallback to `index.html`
for non-API paths so direct links and browser refreshes resolve. Forward `/api`
to the backend (including the sponsor endpoint); do not rewrite API errors to HTML.

## Restricted offline replay (#1931)

Live oracle verification writes the normalized game response, match snapshot
(including identity binding), and request input before evaluating player identity.
Files are content-addressed SHA-256 JSON in `SETTLEMENT_EVIDENCE_DIR`, default
`data/settlement-evidence` relative to the backend working directory. Directory
and file creation modes are 0700 and 0600. The `settlement_evidence_persisted` log
contains the evidence ID. Back up this directory with the settlement records and
apply your incident evidence retention policy; files contain player identifiers.
Persistence errors fail verification instead of returning an unreplayable decision.

Run from `apps/backend` as an operator with filesystem read access:

```sh
SETTLEMENT_REPLAY_ENABLED=true npm run replay:settlement -- --dry-run <evidence-sha256>
```

Replay checks the ID, checksum and schema version, then runs the same pure decision
function used by live verification. It does not read the current match store,
fetch a game, enqueue work, load signing keys, or submit transactions. Repeated
replays cannot submit duplicate transactions because the command has no submission
mode. `--submit`, missing `--dry-run`, arbitrary paths, and disabled replay are
rejected. There is no HTTP replay endpoint. Historical jobs without captured
evidence cannot be reconstructed by this tool; it never substitutes a new API
response. Version 1 denotes the current normalized schema and decision rules;
future rule changes must retain a versioned evaluator for historical evidence.

## Opt-in fee sponsorship (#1934)

The wager pages include an unchecked testnet sponsorship control. The wallet signs
the inner transaction normally. With consent, the browser posts only
`{ signedTxXdr, optIn: true }` to `POST /api/transactions/sponsor`; otherwise it
submits directly to RPC. Sponsor rejection never falls back to charging the player.
The server wraps the unchanged signed transaction, signs the outer fee bump, and
submits it to testnet RPC. No sponsor key or signed outer envelope is returned to
the browser, and the inner XDR is redacted from request logs.

Configure the backend using the example environment variables:

- `FEE_SPONSOR_ENABLED=true`, a funded testnet `FEE_SPONSOR_SECRET`, and
  `FEE_SPONSOR_PLAYERS` containing eligible player G-account public keys.
- `CONTRACT_ESCROW` (or `ESCROW_CONTRACT_ID`) must match the frontend escrow.
- `FEE_SPONSOR_BASE_FEE` is the inclusion fee bid per operation. The SDK includes
  Soroban resource fees in the outer total, which must be at most
  `FEE_SPONSOR_MAX_FEE` (default 1,000,000 stroops).
- `FEE_SPONSOR_DAILY_BUDGET` caps worst-case reserved fees across all players per
  UTC day (default 10,000,000 stroops). `FEE_SPONSOR_DAILY_PLAYER_LIMIT` caps
  reservations per player per UTC day (default 10).

Only a master-key signature from an allowlisted player is accepted; multisig and
muxed accounts are deliberately outside this initial policy. Only a single
`create_match` or `deposit` call to the configured escrow is eligible. Transactions
must have a live time bound no more than five minutes ahead. Network signatures
are verified against testnet; mainnet and nested fee bumps are rejected. The
transaction still needs a valid funded account and any required asset reserves;
fee sponsorship does not create accounts or sponsor trustline reserves.

`FEE_SPONSOR_DB` is a durable SQLite file. All replicas of one sponsor must share
this database through a filesystem with SQLite locking; independent copies do not
share budgets. An atomic reservation records the inner hash, source and sequence
before network I/O. Unique hash and source/sequence constraints prevent repeated
or competing envelopes, even across restart. Reservations remain charged after
rejection, timeout or process crash; automatic retries are intentionally refused.
Inspect the transaction hash/ledger and sequence before taking operational action.
Do not delete the reservation database to retry an uncertain submission. Each new
accepted sequence consumes another quota entry, even for a failed inner call.

See [Stellar's fee-bump specification](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions)
for inner signature preservation, fee source, sequence consumption and fees.

## Verification

Backend tests exercise live decision capture versus offline replay, checksum
failure, operator restrictions, testnet signatures, preservation of the signed
inner envelope, concurrency, same-sequence replacement, fee caps, daily budgets,
player quotas and ambiguous failures. Frontend tests exercise the actual entry
point, single wallet provider, direct routes/remounts, navigation, and sponsored
versus direct submission.

Run the live fee mechanics check from the backend:

```sh
npm run test:sponsorship:testnet
```

It creates disposable Friendbot-funded testnet accounts, issues a test stake asset,
submits an unsponsored asset payment, drains the player's spendable native balance,
checks that another unsponsored payment fails with `tx_insufficient_balance`, and
submits that asset payment inside a sponsor-signed fee bump. It asserts the player
keeps exactly its native reserve and replay returns the same receipt. Keys exist
only in process memory. This check covers live Stellar fee mechanics; the endpoint's
escrow-only policy and RPC interaction are tested with signed testnet envelopes and
a mocked RPC transport. A live escrow lifecycle additionally requires a configured,
initialized deployed escrow and registered players/game.
