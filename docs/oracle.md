# Oracle Design

## Overview

The oracle is the bridge between off-chain chess platforms (Lichess, Chess.com) and the on-chain escrow contract. It is the only address authorised to call `submit_result` on the escrow contract.

## Components

### Oracle Contract (`contracts/oracle`)

An on-chain Soroban contract that:

- Stores verified results keyed by `match_id`
- Accepts result submissions only from the registered admin (the oracle service key)
- Prevents duplicate submissions for the same `match_id`
- Emits an on-chain event for every accepted result

### Off-chain Oracle Service

A backend process that:

1. Monitors the escrow contract for `("match", "activated")` events
2. Extracts `game_id` and `platform` from the match record
3. Polls the appropriate chess platform API until the game is finished
4. Submits the result to the Oracle Contract using the admin key
5. Calls `submit_result` on the Escrow Contract to trigger payout

## Result Submission Flow

```
Chess platform API
       â”‚  game finished
       â–¼
Oracle Service
  1. fetch game result
  2. map to MatchResult enum
  3. oracle_contract.submit_result(match_id, game_id, result)
  4. escrow_contract.submit_result(match_id, winner, oracle_address)
       â”‚
       â–¼
Escrow Contract
  - verifies caller == stored oracle address
  - verifies match state == Active
  - executes token payout
  - sets state = Completed
  - emits ("match", "completed") event
```

## Result Types

| Oracle `MatchResult` | Escrow `Winner` | Payout |
|----------------------|-----------------|--------|
| `Player1Wins` | `Player1` | Full pot to player1 |
| `Player2Wins` | `Player2` | Full pot to player2 |
| `Draw` | `Draw` | `stake_amount` returned to each player |

## Supported Platforms

| Platform | Enum Variant | API |
|----------|-------------|-----|
| Lichess | `Platform::Lichess` | `https://lichess.org/api/game/{id}` |
| Chess.com | `Platform::ChessDotCom` | `https://api.chess.com/pub/game/{id}` |

## Oracle Contract API

```
initialize(admin: Address)
submit_result(match_id: u64, game_id: String, result: MatchResult) -> Result<(), Error>
get_result(match_id: u64) -> Result<ResultEntry, Error>
has_result(match_id: u64) -> bool
```

### Errors

| Error | Code | Meaning |
|-------|------|---------|
| `Unauthorized` | 1 | Caller is not the admin |
| `AlreadySubmitted` | 2 | Result already exists for this match |
| `ResultNotFound` | 3 | No result stored for this match |
| `AlreadyInitialized` | 4 | Contract has already been initialized |

## Security Properties

- The oracle admin key is the only address that can submit results; any other caller is rejected with `Error::Unauthorized`.
- Once a result is submitted it is immutable â€” `AlreadySubmitted` prevents overwriting.
- The escrow contract independently verifies the caller against its stored oracle address before executing any payout.
- The oracle contract and escrow contract are separate deployments; a compromised oracle contract does not grant direct access to escrow funds.
- The off-chain match record's player identities are bound to the match by a hash at creation time (see "Player Identity Binding" below), independently of the on-chain contracts.

## Player Identity Binding

`verifyPlayerIdentities` (`services/player-identity.ts`) checks the usernames
reported by the chess platform API against the usernames captured in the
off-chain match record at creation time — but on its own, that only verifies
against whatever the record *currently* says, with no way to tell whether
those fields have been altered since the match was created.

To close that gap, every match created with both player usernames also gets
an **identity hash**: a SHA-256 digest of

```
normalize(player1Username) : normalize(player1Address) : normalize(player2Username) : normalize(player2Address)
```

(usernames trimmed and lowercased; Stellar addresses trimmed and uppercased
to their canonical StrKey form), computed once by
`computeIdentityHash()` and stored on the match record as `identityHash`.
Order matters — `(alice, P1, bob, P2)` and `(bob, P1, alice, P2)` produce
different hashes, so swapping which player occupies which slot is detectable
even though `verifyPlayerIdentities` itself intentionally accepts a swapped
color assignment.

Before accepting a result, `verifyGameResult` (`services/oracle-service.ts`)
calls `verifyIdentityHash()`, which recomputes the digest from the match
record's *current* `player1`/`player1Username`/`player2`/`player2Username`
fields and compares it to the stored `identityHash`. Any mismatch is rejected
with `Identity hash verification failed` and the submission is refused —
regardless of whether `verifyPlayerIdentities` itself would have passed
against the (now-divergent) current fields. A match created before this
field existed (`identityHash` undefined) is treated as valid, falling back to
`verifyPlayerIdentities` alone, the same behavior as before this existed.

This is independent of, and in addition to, `verifyPlayerIdentities`'s own
API-vs-record comparison — the hash check guards the integrity of the record
itself; the username comparison guards the record against the live API.

## Polling Interval and Job Scheduling

### Polling interval (`POLLING_INTERVAL_MS`)

The off-chain oracle service polls each active match's chess-platform API on a fixed cadence to
detect when the game reaches a terminal state (win, loss, or draw). The cadence is set by
`POLLING_INTERVAL_MS` (milliseconds) and **defaults to 30 000 ms (30 s)**. On each poll the
service checks the game status; once a terminal result is detected it immediately submits the
result on-chain and stops polling that match.

### Max polling attempts (`MAX_POLLING_ATTEMPTS`) and the active-monitoring window

`MAX_POLLING_ATTEMPTS` caps how many times a single match is polled before it is treated as
unresolvable and moved to the dead-letter queue (DLQ). It **defaults to 1440**.

These two values define the **active-monitoring window** for one match:

```
1440 attempts Ã— 30 s/attempt = 43 200 s â‰ˆ 12 hours
```

So the oracle actively watches a match for **~12 hours** after activation. If the game has not
finished within that window, the job is parked in the DLQ (a `max attempts exceeded` alert is
emitted, see `polling_job_max_attempts_exceeded_moving_to_dlq`) and the match remains `Active`
on-chain; players can still call `claim_timeout` once the timeout window elapses (see below).

### Backoff (`POLLING_BACKOFF_MULTIPLIER`)

The delay before the next poll for an in-progress game is
`POLLING_INTERVAL_MS Ã— POLLING_BACKOFF_MULTIPLIER ^ attempt`.
`POLLING_BACKOFF_MULTIPLIER` **defaults to 1.0**, i.e. **no backoff** â€” every attempt is spaced
exactly 30 s apart, which is what yields the ~12-hour window above. Raising the multiplier (e.g.
`1.5`) spreads retries out with exponential backoff, lengthening the total window while the
attempt count stays at 1440.

### Relationship to `TIMEOUT_LEDGERS`

`TIMEOUT_LEDGERS` is **120 960 ledgers (â‰ˆ 7 days at 5 s/ledger)**
(`contracts/escrow/src/lib.rs:98`). It is the on-chain safety net: if the oracle never submits a
result within that window, either player can call `claim_timeout` to recover their stake.

The polling service is designed so that the active-monitoring window sits **well inside** the
on-chain timeout:

- Polling gives **~12 hours** of active monitoring per match (configurable via the constants above).
- The 7-day `TIMEOUT_LEDGERS` window is the **trustless fallback** that protects players when the
  oracle service is down, the DLQ is not being drained, or a game runs far longer than expected.
- A match that exhausts its 1440 polling attempts (â‰ˆ12 h) still has roughly **6.5 days** of
  on-chain protection remaining before `claim_timeout` becomes available.

Operators should confirm their polling/DLQ config comfortably fits inside the 7-day
`TIMEOUT_LEDGERS` window. Because 12 h â‰ª 7 days, the default polling config **covers** the match
timeout with large margin; only a misconfigured `MAX_POLLING_ATTEMPTS` near or above
~20 160 attempts (7 days Ã· 30 s) would begin to encroach on it.

### Configuration

The values above are supplied via the `PollingConfig` object passed to `PollingWorker`
(`apps/backend/src/services/polling.ts`). The default constants are:

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `POLLING_INTERVAL_MS` | `30000` | Base poll interval (30 s) |
| `MAX_POLLING_ATTEMPTS` | `1440` | Attempts before DLQ (~12 h window) |
| `POLLING_BACKOFF_MULTIPLIER` | `1.0` | Backoff factor (1.0 = no backoff) |

Usage in code:

```ts
const worker = new PollingWorker(store, poller, {
  pollingIntervalMs: 30_000,
  maxPollingAttempts: 1440,
  backoffMultiplier: 1.0,
});
```

## Queue Store Persistence

The oracle dead-letter queue (DLQ) is backed by a pluggable `PersistentQueueStore`
(`apps/backend/src/store/`), selected at startup via `QUEUE_STORE`:

| `QUEUE_STORE` | Resolves to | Notes |
|---|---|---|
| unset / `auto` (default) | SQLite | Durable, file-based, no extra service required |
| `sqlite` | SQLite | Same as `auto` |
| `mongodb` | SQLite | The `mongoose` dependency is not installed in this deployment; requests fall back to SQLite with a startup warning |
| `memory` | In-memory | **Development only** — entries are lost on every process restart |

SQLite is the default precisely because DLQ entries represent submissions that already failed
once; losing them silently on a restart (the in-memory store's behavior) means a real payout
failure can go unnoticed. The SQLite store writes to `apps/backend/data/oracle-queue.db` (created
automatically on first use) and survives process restarts and redeploys as long as that file
persists.

**In production, never run with `QUEUE_STORE=memory`.** If `NODE_ENV=production` and `memory` is
requested anyway, `initializeQueue()` auto-corrects to SQLite and logs a warning explaining the
override — this is a deliberate choice over silently allowing data loss in production, since an
operator can always opt back into memory by not setting `NODE_ENV=production` (e.g. staging).
Whenever the in-memory store is actually used (any environment), a warning is logged on startup so
the behavior is never silent.

MongoDB support (`mongodb-queue-store.ts`) exists in the codebase but is not currently wired up:
the `mongoose` package is not an installed dependency, so selecting it falls back to SQLite rather
than crashing the process on a missing module.

## Settlement Boundaries

A settlement crosses these boundaries, in order. A failure can happen at any of them, and
`apps/backend/tests/fault-injection/settlement-boundaries.test.ts` injects one at each. Every case
asserts the same three things:

- the match stays **recoverable**;
- it is **paid out at most once**;
- an operator can see **what happened and what to do**.

| # | Boundary | Failure injected | Expected behaviour | What the operator sees |
|---|----------|------------------|--------------------|------------------------|
| B1 | Match store read (`verifyGameResult`) | store throws (e.g. `SQLITE_BUSY`) | Request fails before any provider call. Nothing is written, and the same request succeeds once the store recovers | 5xx from `/api/oracle/submit-result` with the store error |
| B2 | Provider lookup (Lichess / Chess.com) | 429; outage; repeated failure | 429 → poll stays `in_progress` and is retried next cycle. Outage → poll `failed` with a reason, and nothing is settled. Past `MAX_POLLING_ATTEMPTS` → the job is written to the DLQ | `game_poll_*` logs; a DLQ entry `{ job }` with its reason |
| B3 | Signing | key unavailable, transient or persistent | Retried with backoff. A persistent failure never reaches the chain and is queued | DLQ entry with `signing failed …` |
| B4 | RPC submission | `sendTransaction` fails | Chain untouched, result queued. The DLQ worker settles it once the RPC is back. While the RPC stays down, **one** entry accumulates `attempts` | DLQ entry; `attempts` / `lastAttemptAt` rising |
| B5 | Confirmation | tx landed, confirmation lost | Later attempts are rejected by the contract (one result per match), so there is no second payout. The DLQ retry asks the chain first (`checkResultExistsOnChain`) and resolves the entry **without resubmitting**. If that check itself fails, nothing is resubmitted that cycle (fail-closed) | DLQ entry with `ResultAlreadySubmitted`, then resolved |
| B6 | DLQ write | queue store unavailable | `submitWithRetry` rejects and logs `the DLQ write failed; submission is not persisted`. It does not drop the submission silently | An `error` log line with `matchId` / `gameId` |
| B7 | DLQ retry of a malformed entry | payload isn't an `OracleSubmission` | That entry is kept and its attempt is recorded. Other entries are still processed | Entry with `attempts` rising and the payload to inspect |
| B8 | Process restart between stages | crash after queuing | The SQLite DLQ keeps the entry (and its attempt count). It is settled once after restart, and a duplicate delivery is a no-op | Entry present after restart, then resolved |

Two behaviours these tests pinned down:

- **A DLQ retry is one attempt** (`retryDlqSubmission`). It used to run the whole backoff loop
  inside the worker and then write a *new* DLQ entry and return success. The worker then deleted
  the original, so the attempt count reset to 0 every cycle and the operator could never see how
  long a settlement had been stuck.
- **The DLQ write is awaited.** It wasn't before, so a failing store produced an unhandled
  rejection and the settlement vanished without an error.

The escrow contract's own end-to-end tests (`contracts/escrow/src/tests_e2e.rs`) don't currently
compile on `master`, so the contract-side guarantee in B5 (one result per match) is modelled in
these tests rather than exercised against the contract. Add the matching on-chain case there once
the escrow crate builds.

## DLQ TTL Eviction

DLQ entries are not cleaned up automatically by writing or reading them — without eviction they
would accumulate forever. A background task, started alongside the retry worker in
`server.ts`, periodically deletes entries older than a configurable TTL:

| Env var | Default | Meaning |
|---|---|---|
| `DLQ_TTL_DAYS` | `7` | Age (in days) after which a DLQ entry is evicted. Non-numeric, zero, or negative values fall back to the default with a warning. |

The eviction task runs once every 24 hours and logs the number of entries deleted on each run
(`oracle_dlq: TTL eviction run complete`, with a `deleted` count). It is implemented in
`apps/backend/src/queue.ts` as `evictExpiredDlqEntries()` (the single eviction pass, unit-testable
without a timer) wrapped by `startDlqEvictionTask()` (the periodic scheduler, stopped on graceful
shutdown alongside the retry worker and polling worker).

## Configuration

Set the oracle admin key in `.env`:

```env
ORACLE_ADMIN_SECRET=<stellar-secret-key>
```

The oracle address is registered in the escrow contract at deploy time:

```bash
stellar contract invoke --id $CONTRACT_ESCROW \
  -- initialize \
  --oracle $ORACLE_ADDRESS \
  --admin $ADMIN_ADDRESS
```

## ELO-Based Stake Multiplier (v4.0)

Matches between highly-rated players carry a proportionally larger stake. This
section is the specification for the formula, its parameters, and the failure
policy. The implementation lives in two files:

| File | Role |
| --- | --- |
| `apps/backend/src/services/elo-multiplier.ts` | The formula. Pure, synchronous, no I/O. |
| `apps/backend/src/services/elo.ts` | Lichess rating lookup and the failure policy. |

### Why it is computed off-chain

The multiplier is resolved by the backend and stored as **match metadata**; the
escrow contract never re-derives it.

1. **The contract cannot do it.** A Soroban contract has no HTTP client. Any
   value sourced from the Lichess API has to be fetched before the transaction
   is built.
2. **It keeps the payout path clean.** If the contract re-derived the
   multiplier, a third-party API's uptime and a float formula would sit between
   a completed match and its payout. The payout should depend only on values
   committed on-chain when the match was created.

The stake sent to `create_match` is therefore **already multiplied**. The base
stake the player chose is what the multiplier scales.

### Ratings are read once, at match creation

Both players' ratings are fetched when the match is created, not when the result
arrives. Reading them later would let a rating change between stake and payout,
so the multiplier the winner was offered would no longer be the one the formula
produces. Freezing both inputs at creation makes the price a function of
committed values.

Source: `GET https://lichess.org/api/user/{username}`, scheduled through the
shared Lichess rate limiter so rating lookups and game polls draw from one
budget.

A player is rated by the **first variant they have a rating for**, in the order
`blitz â†’ bullet â†’ rapid â†’ classical`. An account with no rated games in any of
them has no rating â€” that is a normal outcome, not an error.

### The formula

The multiplier scales with the **average** of the two ratings, not their
difference.

```text
average    = (elo1 + elo2) / 2
headroom   = clamp((average - MIN_ELO) / (MAX_ELO - MIN_ELO), 0, 1)
multiplier = BASE_MULTIPLIER + headroom * (MAX_MULTIPLIER - BASE_MULTIPLIER)
stake      = floor(base_stake * multiplier)
```

**Why the average and not the difference.** The rating *difference* is what
decides a game; the rating *level* is what determines what the game is worth.
Two equally strong players at 2600 should carry a bigger pot than the same two
players at 800, even though the outcome is a coin flip in either case. Keying
the multiplier to the difference would price a 2800-vs-2800 match the same as a
2800-vs-800 mismatch, which is not the intent.

### Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `MIN_ELO` | `800` | Average at or below which there is no uplift |
| `MAX_ELO` | `2800` | Average at or above which the multiplier is capped |
| `BASE_MULTIPLIER` | `1.0` | Multiplier at `MIN_ELO`, and the failure fallback |
| `MAX_MULTIPLIER` | `2.0` | Multiplier at `MAX_ELO` |

All four are overridable per call via `EloMultiplierConfig`, so the curve can be
retuned without a code change.

### Worked examples

| Player 1 | Player 2 | Average | Multiplier |
| --- | --- | --- | --- |
| 400 | 400 | 400 | `1.00` (clamped up to the floor) |
| 800 | 800 | 800 | `1.00` (exactly at `MIN_ELO`) |
| 1800 | 1800 | 1800 | `1.50` (midpoint) |
| 2000 | 2400 | 2200 | `1.70` |
| 2800 | 2800 | 2800 | `2.00` (exactly at `MAX_ELO`) |
| 3000 | 3000 | 3000 | `2.00` (clamped down to the ceiling) |

The curve is linear: every 200 rating points of average is exactly `0.1` of
multiplier, because the 800â€“2800 range is 2000 wide and spans 1.0 of multiplier.

### Rounding

The multiplier is **truncated** (rounded down) to two decimals, and the stake is
**floored** to a whole stroop.

Truncation rather than round-to-nearest means the multiplier can never land a
hair *above* `MAX_MULTIPLIER`, and flooring the stake means the contract is
never asked to move more than the multiplier authorises. Both are the
conservative direction: a rounding bug must never cost a player extra money.

A whole-number example: average 1700 gives `headroom = (1700 - 800) / 2000 = 0.45`,
so `multiplier = 1.45`. A base stake of `101` stroops then becomes
`floor(101 x 1.45) = floor(146.45) = 146` - rounded **down**, never up.

### Failure policy

**A failed rating lookup prices the match at the base stake (multiplier 1).**

This is the conservative direction by construction. A player must never lose
money because an external API was slow, and defaulting *up* would let an outage
inflate stakes. Every failure path in `elo.ts` â€” unknown user, 404, 429, network
error, malformed payload, account with no rated games â€” resolves to "no rating"
rather than throwing, and `resolveMultiplier` turns that into multiplier 1.

Two details worth stating explicitly:

- **An unknown player is rated `MIN_ELO` (800), not a realistic-looking default.**
  Substituting, say, 1500 for a player we failed to look up would hand them a
  1.25x uplift they did not earn. Assuming the floor treats an unknown player
  exactly like a beginner.
- **One known rating does not uplift the match.** If only one rating resolves,
  the match is priced at the base stake even when the surviving rating is
  2800. The uplift prices the *match*, and half of that input is missing. The
  result is flagged `degraded: true` with a reason so it can be logged.

### Stored match metadata

`resolveMatchMultiplier` returns the multiplier *and* the inputs it used, so the
pricing decision stays auditable after the fact:

| Field | Meaning |
| --- | --- |
| `multiplier` | Applied to the base stake; always `>= 1` |
| `player1Elo`, `player2Elo` | Ratings used, including any substituted `UNKNOWN_ELO` |
| `averageElo` | Average of the two |
| `degraded` | `true` when either rating was substituted |
| `reason` | Present only when `degraded` |

The match record stores these alongside the base and final stake, so a dispute
about "why was this match priced at 1.7x" can be settled by reading the record
rather than re-deriving it from a rating that has since changed.

### Configuration

```env
# Optional â€” override the curve without a code change.
ELO_MIN_MULTIPLIER_ELO=800
ELO_MAX_MULTIPLIER_ELO=2800
ELO_BASE_MULTIPLIER=1.0
ELO_MAX_MULTIPLIER=2.0
```

### Tests

`apps/backend/tests/elo-multiplier.test.ts` (38 tests) covers the formula
exhaustively, because this function decides how much real money is escrowed:

- both boundaries (`MIN_ELO`, `MAX_ELO`) and values beyond them in both
  directions, to prove the clamps hold
- symmetry under argument order, and that the result depends on the average
  rather than the difference
- monotonicity across the whole range, checked in 200-point steps
- an exact table of eleven known rating/multiplier pairs
- the truncation cases, including one that does not divide evenly
- degenerate and inverted configuration ranges, which would otherwise divide
  by zero and emit `NaN` into a stake amount
- every missing-rating shape, including `NaN` and `Infinity`
- `RangeError` guards rejecting a non-positive stake or a sub-1 multiplier

`apps/backend/tests/elo.test.ts` (21 tests) covers the lookup: URL
construction and encoding, the variant preference order, and the requirement
that every failure mode degrades to `null` rather than throwing.
