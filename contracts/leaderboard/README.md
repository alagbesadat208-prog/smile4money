# Leaderboard Contract

Tracks lifetime win / loss / draw records and total earnings per Stellar
address, so a frontend can render a ranked leaderboard without replaying the
escrow's entire history off-chain.

- [How results get in](#how-results-get-in)
- [Identity and edge cases](#identity-and-edge-cases)
- [Public functions](#public-functions)
- [Errors](#errors)
- [Events](#events)
- [Security notes](#security-notes)

## How results get in

The escrow contract emits an event when a match completes. A Soroban contract
**cannot observe another contract's events**, so a **trusted relayer** (the
existing oracle service) reads the payout event and calls `record_result`.

This is deliberately *not* "anyone can submit". A leaderboard any caller can
write to is not a leaderboard, it is a graffiti wall. Forgetting a result is
recoverable — replay it; corrupting one is not.

### Why the relayer is an acceptable trust boundary

The leaderboard is a **display** contract. It escrows nothing and moves no
funds, so a dishonest relayer can only produce a wrong ranking — it cannot steal
anything. That keeps the blast radius of compromising this contract small,
which is the right trade for a feature whose only job is a leaderboard page.

Payout correctness is unaffected: it lives in the escrow contract and is
already final by the time this contract hears about a result.

## Identity and edge cases

A player is identified by the address that actually escrowed — the Stellar
address, not a platform username. Usernames are reassignable on both Lichess
and Chess.com, so tying a permanent record to one would let a new account
inherit an old player's history.

Every recorded result must name **two distinct** players. A result where both
sides are the same address is rejected rather than counted, because it would
hand one player a win and a loss simultaneously and inflate `matches_played`.

## Public functions

### `initialize`

```rust
pub fn initialize(env: Env, admin: Address, source: Address) -> Result<(), Error>
```

Registers the administrator and the first data source. Both must authorise the
call. Emits `("admin", "init")`.

**Errors:** `AlreadyInitialized` if called more than once.

---

### `record_result`

```rust
pub fn record_result(
    env: Env,
    player1: Address,
    player2: Address,
    outcome: MatchOutcome,
    payout: i128,
    token: Address,
    settlement_id: String,
    caller: Address,
) -> Result<(), Error>
```

Records one completed match. On a decisive result the winner gains a win and
the `payout` in `earnings`; the loser gains a loss. On a draw both sides gain a
draw and **nobody is credited** — the escrow returned each player's own stake,
so no one was paid, and counting a refund as earnings would inflate the board
for players who draw often.

`earnings` is stored in the token's smallest unit, so the `token` address is
recorded alongside it. Amounts in different tokens are **not** comparable
numbers, and a caller that sums them without grouping by currency would be
adding unlike units.

Emits `("result", "recorded")`.

**Authorization:** only a registered data source (`caller`).

`settlement_id` is required and acts as an idempotency key. A retry with the
same ID is a no-op. Use the escrow settlement identifier consistently across
retries; settlement IDs are retained for the same ledger TTL as player stats.

**Errors:**
- `Unauthorized` — caller is not a registered source
- `ContractPaused` — recording is paused
- `InvalidResult` — `player1 == player2`, or `payout` is negative

---

### `get_leaderboard`

```rust
pub fn get_leaderboard(env: Env, limit: u32, offset: u32) -> Result<Vec<LeaderboardEntry>, Error>
```

Returns a page of the leaderboard. `limit` is capped at `MAX_PAGE_SIZE` (50), so
a caller asking for more gets one full page rather than a response too large to
return in a single transaction.

**Ordering:** wins descending, then `earnings` descending, then address
ascending.

The address tie-break is **not cosmetic**. Without it two players with
identical records have no defined relative order, and paging would show the
same row twice across page boundaries while silently skipping another. There is
a test for exactly this.

Only players with at least one completed match appear. Paging to the end
returns a short page rather than an error — that is the normal "no more
results" signal for a paginated read.

**Errors:** `InvalidRange` if `limit` is zero, or `offset` is past the end.

---

### `get_stats`

```rust
pub fn get_stats(env: Env, player: Address) -> PlayerStats
```

One player's record. Returns a **zeroed record** rather than an error for a
player who has never played, so callers never have to handle an absent player.

---

### `add_source` / `remove_source`

```rust
pub fn add_source(env: Env, source: Address, caller: Address) -> Result<(), Error>
pub fn remove_source(env: Env, source: Address, caller: Address) -> Result<(), Error>
```

Admin-only. `add_source` authorises an extra relayer, for example during a
failover; `remove_source` revokes one. Results a source already recorded are
untouched — revoking write permission is not a rollback.

---

### `set_paused`

```rust
pub fn set_paused(env: Env, paused: bool, caller: Address) -> Result<(), Error>
```

Admin-only. Rejects `record_result` calls while paused. The relayer keeps
calling; calls are refused rather than queued. This exists so a relayer that
has started writing nonsense can be stopped without unregistering it and
rebuilding state.

### Read-only views

| Function | Returns |
|---|---|
| `is_source(env, source) -> bool` | Whether an address may record results |
| `is_paused(env) -> bool` | Whether recording is paused |
| `result_count(env) -> u32` | Results recorded so far |
| `get_admin(env) -> Result<Address, Error>` | The configured admin |

## Errors

| Code | Variant | Meaning |
|---|---|---|
| 1 | `AlreadyInitialized` | `initialize` called more than once |
| 2 | `Unauthorized` | Caller is not an admin or registered source |
| 3 | `NotInitialized` | Contract has not been initialized |
| 4 | `InvalidResult` | Same player on both sides, or negative payout |
| 5 | `InvalidRange` | `limit` is zero, or `offset` is past the end |
| 6 | `ContractPaused` | Result recording is paused |

## Events

| Event | Data |
|---|---|
| `("admin", "init")` | `(admin, source)` |
| `("admin", "src_add")` | `(source, caller)` |
| `("admin", "src_del")` | `(caller)` |
| `("admin", "pause_set")` | `(paused, caller)` |
| `("result", "recorded")` | `(player1, player2, outcome, payout, token, result_count)` |

## Security notes

- **The relayer is trusted, and that is scoped.** It can misreport a result but
  cannot move funds. Any future change that lets this contract hold or transfer
  assets invalidates that argument and must be re-reviewed.
- **`caller.require_auth()`** is called on every write, so a relayer transaction
  cannot be forged by submitting on its behalf.
- **No admin backdoor to rewrite history.** The admin can pause recording and
  manage sources; it cannot edit or delete a recorded result. Correcting a bad
  result means recording the truth and reconciling off-chain.
- **Unbounded roster growth is the known scaling limit.** `get_leaderboard`
  sorts on every read with insertion sort, which is `O(n^2)` in the roster size
  — adequate while the board is small, and the first thing to revisit if it is
  not. The alternative (a maintained on-chain sorted index) costs far more per
  write, which is the wrong trade for a display contract.
