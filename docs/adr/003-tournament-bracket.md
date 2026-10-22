# ADR-003: Single-Elimination Tournament Bracket Contract

- **Status:** Accepted
- **Date:** 2026-09-25
- **Issue:** #1802 / #123 (v2.0 roadmap — multi-game tournament support)
- **Supersedes:** nothing
- **Related:** ADR-001 (dispute window), ADR-002-immutable-safe-address

## Context

`EscrowContract` models exactly one 1v1 chess match. The v2.0 roadmap calls for
multi-player competitions, which raises a question the escrow contract was never
asked to answer: who holds the money when there are more than two players, and
who decides that a match is over?

The existing pieces do not compose on their own:

- `EscrowContract::create_match` takes exactly two players, and
  `finalize_result` pays `stake_amount × 2` to the winner. Chaining N escrow
  matches does not produce a tournament — it produces N independent 1v1 bets
  with N separate pots.
- `OracleContract::submit_result` is keyed by a `u64` match ID and reports a
  `MatchResult` of `Player1Wins` / `Player2Wins` / `Draw`. A draw has no meaning
  in a single-elimination bracket, and `Player1Wins` is meaningless without a
  `Match` record to resolve it against.

A tournament needs its own contract that owns the entry fees, owns the bracket
structure, and turns an oracle result into "this player is in the next round".

## Decision

Add a new `smile4money-tournament-bracket` Soroban contract implementing a
**single-elimination bracket for a power-of-two field**.

### 1. The bracket is data in one contract, not a tree of deployed contracts

**Decision:** the tree of matches lives in this contract's storage as
`MatchNode` records. A tournament of N players creates N−1 `MatchNode` records.
No per-match contract is deployed.

The roadmap language is "creates a tree of match contracts". Deploying one
contract per match was considered and rejected:

| | One node contract per match | Nodes in one contract (**chosen**) |
| --- | --- | --- |
| Deployment cost | N−1 deployments, each with its own WASM instance | one deployment |
| Prize pool | N separate pots that must be reconciled off-chain and on-chain | one balance, one invariant |
| Round advancement | requires N−1 cross-contract calls per round | one storage write |
| Advancement atomicity | a partial round leaves a half-advanced tree | one transaction, all-or-nothing |
| Audit surface | N× the contract interface | one interface |

A "tree of match contracts" also cannot work with the existing `EscrowContract`
unchanged: its 1v1 shape has nowhere to put a third player, and its
`finalize_result` pays out per match, which — see §3 — is the wrong shape for a
prize pool.

**Rejected alternative: reuse `EscrowContract` N times.** Preserves deployment
cost and the audit surface, but loses the atomicity of a round and forces the
prize pool to be tracked outside the contracts entirely. The prize pool is the
one thing that most needs to be an on-chain invariant.

### 2. Bracket shape and seeding

- `player_count` must be a power of two, `2 ≤ player_count ≤ 64` (6 rounds).
  No byes, so no seed is ever idle.
- `rounds = log2(player_count)`; round 0 is the first round, round `rounds - 1`
  is the final. Round `r` has `player_count >> (r + 1)` nodes.
- Node `i` of round `r` feeds node `i / 2` of round `r + 1`, into `player1`
  when `i` is even and `player2` when `i` is odd.
- Entrants are seeded **snake-style** in the order they are supplied: seed 1
  plays seed N, seed 2 plays seed N−1, and so on. The strongest and weakest
  seeds are kept apart for as long as possible, and the top two seeds can only
  meet in the final. For a 4-player bracket, `[s0 s3] [s1 s2]`.

### 3. Prize accounting: entry fee once, whole pot to the champion

**Decision:** each entrant pays `entry_fee` exactly once, at
[`deposit`]. No per-match payouts happen during the tournament. When the final
is decided, the champion is allocated the entire pot,
`entry_fee × player_count`.

This is the part that most needs to be stated explicitly, because the obvious
alternative is wrong:

> If each match paid its winner `2 × entry_fee` as it does in `EscrowContract`,
> round 1 of a 4-player tournament would pay out 2 matches × 2 × fee = 4 × fee,
> which is the *entire* pot. The pot would be empty before the final.

An earlier-round winner is paid nothing and simply advances; their fee stays in
the pot and is only realised if they go on to win the whole thing. This makes
the invariant a one-liner:

```
live tournament pot == entry_fee * funded_count
allocated tournament pot still held == settlement.remaining
```

After the champion claims, the settlement's remaining amount is zero and the
champion's balance rises by `entry_fee * player_count`. Across tournaments the
contract holds live funded pots plus outstanding settlement balances, the reserve,
and any unsolicited transfers.

### 4. Winners advance on oracle result submission

**Decision:** the trusted oracle reports the result of a single node via
[`submit_match_result`]. Advancement happens inside that call, so a winner is
advanced by the same transaction that records the result.

- Only the registered oracle may call it.
- The reported `winner` must be one of the node's two `Address`es. A `Draw` is
  not representable: there is no `MatchResult` parameter, the oracle names the
  advancing `Address`, and a name that is not one of the two players is
  rejected. This is strictly safer than reusing `MatchResult`, which is
  positional (`Player1Wins`) and therefore only meaningful alongside a `Match`.
- If the node is not in the final, its winner is written into the parent node
  and the parent becomes `AwaitingResult` once both its slots are filled.
- If the node *is* the final, the tournament becomes `Completed` and the pot is
  allocated to the champion; `claim_prize` transfers it in a separate call.

No dispute window is added here. A tournament node is not a match between two
parties with money at risk in the way an escrow match is — nothing is released
until the final, and an early result only advances a player who has already paid
their fee. Correcting an early result is a matter of re-running the oracle with
an authoritative bracket. **This is a deliberate simplification and the most
likely thing to revisit**: if early-round results do need to be disputable, the
node needs a `pending_winner` and a `DISPUTE_WINDOW_LEDGERS` delay exactly as
ADR-001 specifies for `EscrowContract`.

### 5. Nobody can lock the pot

A tournament that stalls must not be able to hold player money indefinitely. Two
exit paths, both allocating a full refund for every funded entrant:

- [`cancel_tournament`] — admin, while the tournament is still `Registration`
  (i.e. no match has been decided). Allocation is immediate; each recipient collects separately.
- [`claim_timeout`] — callable by **anyone** once `TIMEOUT_LEDGERS` have elapsed
  since the tournament was created. This is the trustless backstop, and mirrors
  `EscrowContract::claim_timeout`, which is likewise permissionless.

**Known limitation:** a tournament that is decided-but-not-final is resolved by
refunding everyone, not by advancing a default winner. Deciding who advances when
a player refuses to play (rematch deadline, walkover, seeding penalty) is real
policy and is deliberately out of scope here. Until it exists, a stalled
tournament resolves in favour of *everyone getting their money back*, which is
the safe direction to be wrong in.

### 6. Resumable settlement (#1880)

The current policy has one champion, not a configurable prize list. The old
unbounded payment loop was the refund path. Finalization, cancellation and
timeout now allocate once without token calls or a scan over recipients. Each
claim reads a constant number of records and performs at most one transfer.

| API | Caller / destination | Result |
| --- | --- | --- |
| `get_settlement(id)` | Read-only | `total`, `remaining`, `unclaimed`, `claimed` bitmap |
| `claim_prize(id)` | Anyone; destination is the recorded champion | Whole allocated pot, once |
| `claim_refund(id, node_index, recipient)` | Anyone; recipient must be a funded entrant of round-0 node `node_index` | One entry fee, once |

For refunds, obtain the recipient's round-0 node from the bracket. Slot
`2 * node_index` is player1; `2 * node_index + 1` is player2. Those slots map to
the 64-bit claimed bitmap. Prize settlement uses bit 0. The claim transaction
needs no recipient signature and cannot redirect payment. A relayer can resume
in any order by reading the bitmap; a duplicate returns `AlreadyClaimed` without
transferring funds. A failed reserve check or token transfer rolls back all claim
progress and can be retried. A blocked recipient does not block other claims.

`Completed` / `Cancelled` now mean bracket progression is terminal, not that all
money moved. `unclaimed == 0` and `remaining == 0` indicate settlement completion.
For cancelled tournaments, `funded_count` counts outstanding refunds and decreases
on successful claims. Round-0 funding flags remain immutable entitlement evidence.

Events `champion`, `cancelled`, and `timeout` retain their payloads but now describe
allocation. New `("tournament", "allocated")` data is `(id, total, recipient_count)`;
`("tournament", "claimed")` data is `(id, recipient, amount)` and is emitted only
on successful payment. Indexers must use `claimed` events to record transfers.

**Upgrade/integration:** existing entrypoint signatures and Tournament/MatchNode
layouts are unchanged. The new persistent `DataKey::Settlement(id)` is additive;
no existing records need rewriting. Legacy terminal records have no settlement
marker because they already paid inline, and new claims reject them with
`SettlementNotFound`. Active records allocate when next finalized. Deploy the new
WASM and update clients/relayers for the payout timing change together; regenerate
bindings for the three new entrypoints and error codes 39-41. This is a behavioral
compatibility change even though existing call signatures remain valid.

Settlement state and replay bits share one persistent record and TTL, extended on
every successful claim. Tournament and referenced refund node TTLs are refreshed
as well. Archived records must be restored using Soroban's restoration workflow
before claiming; never recreate missing allocations or clear their bitmap. Terminal
state guards prevent allocation from restarting. There is no claim-expiry confiscation.

Build the tournament for `wasm32v1-none` on the pinned Rust 1.88 toolchain:

```sh
rustup target add wasm32v1-none
cargo build -p smile4money-tournament-bracket --target wasm32v1-none --release
```

The default `wasm32-unknown-unknown` target on this toolchain emits reference-types
instructions that the SDK 22 host rejects; the MVP-compatible target avoids them.

Tests cover the maximum 64-player field: timeout allocation plus all 64 independent
refunds, partial cancellation, final prize allocation and claim, replay protection,
invalid entitlement and transfer/reserve failure recovery. Resource tests reset the
SDK default CPU/memory budget for each measured call. Native host measurements
underestimate WASM execution and are not production network simulation; deployment
must still simulate claims to set network-specific resource declarations.

## Consequences

### Positive

- One place to reason about the whole tournament, so the pot is a checkable
  on-chain invariant rather than an off-chain reconciliation.
- A round advances atomically, so the tree is never half-advanced.
- Reuses the repo's existing vocabulary: same TTL constants
  (`MATCH_TTL_LEDGERS`, `TIMEOUT_LEDGERS`, `ESCROW_RESERVE_BUFFER_STROOPS` from
  `smile4money_common::constants`), same `game_id` validation, same
  immutable-`safe_address` posture as
  [ADR-002-immutable-safe-address](002-immutable-safe-address.md), same
  `is_zero_address` and `ensure_reserve_for_payout` guards as the escrow.
- Power-of-two only means no byes and therefore no "ghost match" nodes, which is
  the usual source of off-by-one bugs in bracket code.

### Negative

- `MAX_PLAYERS = 64` bounds a tournament. Larger fields need a different shape.
- No dispute window on intermediate results (§4).
- No double elimination, no seeding overrides, no consolation brackets. The
  bracket is a fixed complete binary tree; anything else needs a different
  progression rule.
- Fee is `entry_fee × player_count` held in **this** contract's token balance,
  so a single large tournament consumes one account's balance. The reserve guard
  accounts for that, but it does mean the pot is not sharded.

### Neutral

- The oracle contract is **not** modified. The bracket reads the same off-chain
  game results the oracle already polls, but calls into the bracket directly
  with the advancing `Address`. Wiring the existing `OracleContract` to fan out
  to brackets is a separate change, so this contract is deployable and testable
  now.

## Test strategy

`contracts/tournament-bracket/src/tests.rs` covers:

- **Full 4-player progression** (the acceptance criterion): all four entrants
  fund, the two semifinals are decided, the winners land in the final node, the
  final is decided, and the champion is paid `entry_fee × 4` with the pot
  drained to the reserve.
- Structural invariants: N players always produce N−1 nodes; seeding pairs
  `[s0 s3] [s1 s2]`; `2^k` players produce k rounds.
- Rejections: non-power-of-two field, duplicate entrants, zero addresses,
  outsider funding, double funding, a result for a node that is not yet
  `AwaitingResult`, a winner who is not one of the two players, a non-oracle
  caller, a re-submitted result.
- Cancellation: admin cancel refunds every funded entrant; `claim_timeout`
  before the deadline is rejected and refunds everyone after it.
