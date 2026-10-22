# Escrow Contract

A Soroban smart contract for trustless chess match wagering on Stellar. It holds player stakes in escrow and releases funds to the winner (or refunds on draw/cancel) based on results submitted by a trusted oracle.

---

## Table of Contents

- [Overview](#overview)
- [Types](#types)
  - [MatchState](#matchstate)
  - [Platform](#platform)
  - [Winner](#winner)
  - [Match](#match)
- [Errors](#errors)
- [Public Functions](#public-functions)
  - [initialize](#initialize)
  - [update_oracle](#update_oracle)
  - [add_token](#add_token)
  - [remove_token](#remove_token)
  - [is_token_allowlisted](#is_token_allowlisted)
  - [pause](#pause)
  - [unpause](#unpause)
  - [create_match](#create_match)
  - [deposit](#deposit)
  - [submit_result](#submit_result)
  - [cancel_match](#cancel_match)
  - [get_match](#get_match)
  - [is_funded](#is_funded)
  - [get_escrow_balance](#get_escrow_balance)
- [Match Lifecycle](#match-lifecycle)
- [Events](#events)
- [Testing](#testing)
- [Security Notes](#security-notes)

---

## Overview

```
Player1 + Player2 agree on a stake
        │
        ▼
   create_match()  ──► Pending
        │
   deposit() x2   ──► Active
        │
  submit_result() ──► PendingResult  (dispute window; admin may correct)
        │
  finalize_result() ──► Completed  (winner gets 2× stake, or draw refunds both)
        │
   cancel_match() ──► Cancelled  (refunds any deposits already made)
```

The contract is initialized once with an **admin** and an **oracle** address. The admin controls administrative operations (pause/unpause, oracle rotation). The oracle is the only address authorized to submit match results.

### Settlement finality and leaderboard accounting

`submit_result` creates a provisional result. During the dispute window,
`override_result` can replace it, and its audit event records both the prior
and replacement winner. `finalize_result` pays the current winner and moves the
match to terminal `Completed` state. Leaderboard relayers should record only
the `match/completed` event; provisional results, corrections, and cancelled
matches do not count. A finalized payout cannot be refunded or rewritten by
this contract, so leaderboard totals are immutable after finalization. Any
future protocol that supports post-final refunds must introduce an explicit
compensating accounting entry rather than deleting the original result.

---

## Types

### MatchState

```rust
pub enum MatchState {
    Pending,    // Created, awaiting both deposits
    Active,     // Both players deposited; game in progress
    PendingResult, // Result submitted; dispute window is open
    Completed,  // Result finalized; payout executed
    Cancelled,  // Cancelled before activation
}
```

### Platform

```rust
pub enum Platform {
    Lichess,
    ChessDotCom,
}
```

Identifies the chess platform where the game is played.

### Winner

```rust
pub enum Winner {
    Player1,  // Player1 wins; receives 2× stake
    Player2,  // Player2 wins; receives 2× stake
    Draw,     // Both players refunded their stake
}
```

### Match

```rust
pub struct Match {
    pub id: u64,
    pub player1: Address,
    pub player2: Address,
    pub stake_amount: i128,
    pub token: Address,
    pub game_id: String,
    pub platform: Platform,
    pub state: MatchState,
    pub player1_deposited: bool,
    pub player2_deposited: bool,
    pub created_ledger: u32,  // Ledger sequence at creation
}
```

---

## Errors

| Code | Name | Description |
|------|------|-------------|
| 1 | `MatchNotFound` | No match exists for the given `match_id` |
| 2 | `AlreadyFunded` | The calling player has already deposited for this match |
| 3 | `NotFunded` | Result submitted before both players deposited |
| 4 | `Unauthorized` | Caller is not authorized for this operation |
| 5 | `InvalidState` | Operation not allowed in the match's current state |
| 6 | `AlreadyExists` | A match with this ID already exists |
| 7 | `AlreadyInitialized` | Contract has already been initialized |
| 8 | `Overflow` | Internal match counter overflow |
| 9 | `ContractPaused` | Contract is paused; operation blocked |
| 10 | `InvalidAmount` | Stake amount must be greater than zero |
| 11 | `InvalidGameId` | `game_id` exceeds the 64-byte maximum length |
| 12 | `InvalidPlayers` | `player1` and `player2` are the same address |
| 13 | `GameIdMismatch` | Oracle submitted a result with a `game_id` that doesn't match the stored match |
| 14 | `DuplicateGameId` | A match with this `game_id` already exists |

---

## Public Functions

### `initialize`

Initializes the contract. Must be called exactly once before any other function.

```rust
pub fn initialize(env: Env, oracle: Address, admin: Address)
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `oracle` | `Address` | The trusted oracle address authorized to submit match results |
| `admin` | `Address` | The admin address authorized to pause/unpause and rotate the oracle |

**Panics**

- `"Contract already initialized"` — if called more than once.

**Example**

```rust
client.initialize(&oracle_address, &admin_address);
```

---

### `update_oracle`

Rotates the trusted oracle address. Only the admin can call this.

```rust
pub fn update_oracle(env: Env, new_oracle: Address) -> Result<(), Error>
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `new_oracle` | `Address` | The new oracle address to set |

**Returns** `Ok(())` on success.

**Errors**

| Error | Condition |
|-------|-----------|
| `Unauthorized` | Caller is not the admin |

**Events**

Emits `("admin", "oracle")` with the new oracle address as data.

**Example**

```rust
// Must be called by admin
client.update_oracle(&new_oracle_address);
```

---

### `add_token`

Allowlists a SEP-41 token so that `create_match` may name it. Only the admin
can call this. Emits `("admin", "token_add")`.

```rust
pub fn add_token(env: Env, token: Address, caller: Address) -> Result<(), Error>
```

The token is probed (its `decimals` is read) so a typo or a non-token address is
rejected at configuration time rather than later at a player's deposit.

Allowlisting a token is **not** an endorsement of it — it only records that the
admin accepts it as a stake currency. The allowlist exists so an arbitrary
caller cannot point the escrow at a contract of their choosing; deciding which
currencies to list stays with the admin, and every change is recorded on-chain.

**Errors**

| Error | Condition |
|-------|-----------|
| `Unauthorized` | Caller is not the admin |
| `TokenAlreadyListed` | The token is already allowlisted |

---

### `remove_token`

Removes a token from the allowlist so no new match may be created in it. Only
the admin can call this. Emits `("admin", "token_del")`.

```rust
pub fn remove_token(env: Env, token: Address, caller: Address) -> Result<(), Error>
```

**In-flight matches are unaffected.** Removal blocks *new* matches only; it does
not touch matches that already exist. Their escrows stay in that token and
still settle and pay out there, so a player who funded a match is never stranded
mid-game. This is how a broken currency can be delisted safely.

**Errors**

| Error | Condition |
|-------|-----------|
| `Unauthorized` | Caller is not the admin |
| `TokenNotListed` | The token was not allowlisted |
| `CannotRemoveDefault` | The token is the contract's default token |

The default token set at `initialize` cannot be removed — otherwise the contract
could be left accepting no token at all, with no way to recover short of an
upgrade.

---

### `is_token_allowlisted`

Read-only check of whether a token is currently accepted.

```rust
pub fn is_token_allowlisted(env: Env, token: Address) -> bool
```

Lets a frontend grey out a currency selector without attempting a doomed
`create_match`. The default token is always allowlisted.

---

### `pause`

Pauses the contract. Blocks `create_match`, `deposit`, and `submit_result`. Only the admin can call this.

```rust
pub fn pause(env: Env) -> Result<(), Error>
```

**Returns** `Ok(())` on success.

**Errors**

| Error | Condition |
|-------|-----------|
| `Unauthorized` | Caller is not the admin |

**Events**

Emits `("admin", "paused")` with no data.

**Example**

```rust
client.pause(); // called by admin
```

---

### `unpause`

Unpauses the contract, re-enabling all operations. Only the admin can call this.

```rust
pub fn unpause(env: Env) -> Result<(), Error>
```

**Returns** `Ok(())` on success.

**Errors**

| Error | Condition |
|-------|-----------|
| `Unauthorized` | Caller is not the admin |

**Events**

Emits `("admin", "unpaused")` with no data.

**Example**

```rust
client.unpause(); // called by admin
```

---

### `create_match`

Creates a new match and puts it in `Pending` state. `player1` must authorize this call. Both players must subsequently call `deposit` before the match becomes `Active`.

```rust
pub fn create_match(
    env: Env,
    player1: Address,
    player2: Address,
    stake_amount: i128,
    token: Option<Address>,
    game_id: String,
    platform: Platform,
) -> Result<u64, Error>
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `player1` | `Address` | First player; must authorize this call |
| `player2` | `Address` | Second player |
| `stake_amount` | `i128` | Amount each player must deposit (must be > 0) |
| `token` | `Option<Address>` | SEP-41 token for this match. `None` uses the contract's default token. A non-`None` value must be on the admin-managed allowlist (see [`add_token`](#add_token)). |
| `game_id` | `String` | Unique identifier for the chess game (max 64 bytes) |
| `platform` | `Platform` | Chess platform (`Lichess` or `ChessDotCom`) |

The resolved token is stored on the match and is the token `deposit` pulls and
the payout pays out in. Matches in different tokens can run side by side in the
same contract.

**Returns** `Ok(u64)` — the new match ID (auto-incremented from 0).

**Errors**

| Error | Condition |
|-------|-----------|
| `ContractPaused` | Contract is currently paused |
| `InvalidAmount` | `stake_amount` is ≤ 0 |
| `InvalidPlayers` | `player1 == player2` |
| `InvalidGameId` | `game_id` length exceeds 64 bytes |
| `DuplicateGameId` | A match with this `game_id` already exists |
| `AlreadyExists` | Internal: match ID collision (should not occur in practice) |
| `Overflow` | Internal match counter overflow |

**Events**

Emits `("match", "created")` with data `(match_id, player1, player2, stake_amount)`.

**Storage**

Match data is stored with a TTL of ~30 days (518,400 ledgers at 5s/ledger). The `game_id` is also stored to prevent reuse.

**Example**

```rust
let match_id = client.create_match(
    &player1,
    &player2,
    &100_0000000i128,       // 100 tokens (7 decimal places)
    &token_address,
    &String::from_str(&env, "lichess-game-abc123"),
    &Platform::Lichess,
);
```

---

### `deposit`

Deposits a player's stake into escrow. Each player calls this once. When both players have deposited, the match transitions from `Pending` to `Active`.

```rust
pub fn deposit(env: Env, match_id: u64, player: Address) -> Result<(), Error>
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `match_id` | `u64` | The ID of the match to deposit into |
| `player` | `Address` | The depositing player; must authorize this call |

**Returns** `Ok(())` on success.

**Errors**

| Error | Condition |
|-------|-----------|
| `ContractPaused` | Contract is currently paused |
| `MatchNotFound` | No match exists for `match_id` |
| `InvalidState` | Match is not in `Pending` state |
| `Unauthorized` | `player` is neither `player1` nor `player2` |
| `AlreadyFunded` | This player has already deposited |

**Events**

- Emits `("match", "deposit")` with data `(match_id, player)` on each deposit.
- Emits `("match", "activated")` with data `match_id` when both players have deposited.

**Token Transfer**

Transfers `stake_amount` tokens from `player` to the contract address using the token's `transfer` function. The player must have approved the contract to spend at least `stake_amount`.

**Example**

```rust
// Player1 deposits
client.deposit(&match_id, &player1);

// Player2 deposits — match becomes Active
client.deposit(&match_id, &player2);
```

---

### `submit_result`

Called by the oracle to submit the verified match result and trigger payout. The `game_id` parameter must match the one stored in the match to prevent cross-match result injection.

```rust
pub fn submit_result(
    env: Env,
    match_id: u64,
    game_id: String,
    winner: Winner,
    caller: Address,
) -> Result<(), Error>
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `match_id` | `u64` | The ID of the match |
| `game_id` | `String` | Must match the `game_id` stored in the match |
| `winner` | `Winner` | The outcome: `Player1`, `Player2`, or `Draw` |
| `caller` | `Address` | Must be the registered oracle address; must authorize this call |

**Returns** `Ok(())` on success.

**Errors**

| Error | Condition |
|-------|-----------|
| `ContractPaused` | Contract is currently paused |
| `Unauthorized` | `caller` is not the registered oracle |
| `MatchNotFound` | No match exists for `match_id` |
| `GameIdMismatch` | `game_id` does not match the match's stored `game_id` |
| `InvalidState` | Match is not in `Active` state |
| `NotFunded` | One or both players have not deposited (should not occur if state is `Active`) |

**Payout Logic**

| Winner | Payout |
|--------|--------|
| `Player1` | Player1 receives `stake_amount × 2` |
| `Player2` | Player2 receives `stake_amount × 2` |
| `Draw` | Each player receives their `stake_amount` back |

**Events**

Emits `("match", "completed")` with data `(match_id, winner)`.

**Example**

```rust
// Oracle submits result
client.submit_result(
    &match_id,
    &String::from_str(&env, "lichess-game-abc123"),
    &Winner::Player1,
    &oracle_address,
);
```

---

### `cancel_match`

Cancels a `Pending` match and refunds any deposits already made. Either player can cancel.

```rust
pub fn cancel_match(env: Env, match_id: u64, caller: Address) -> Result<(), Error>
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `match_id` | `u64` | The ID of the match to cancel |
| `caller` | `Address` | Must be `player1` or `player2`; must authorize this call |

**Returns** `Ok(())` on success.

**Errors**

| Error | Condition |
|-------|-----------|
| `MatchNotFound` | No match exists for `match_id` |
| `InvalidState` | Match is not in `Pending` state (cannot cancel `Active` or `Completed` matches) |
| `Unauthorized` | `caller` is neither `player1` nor `player2` |

**Refund Logic**

Only deposits that have been made are refunded. If only one player deposited before cancellation, only that player is refunded.

**Events**

Emits `("match", "cancelled")` with data `match_id`.

**Example**

```rust
// Player1 deposited but wants to cancel before player2 deposits
client.deposit(&match_id, &player1);
client.cancel_match(&match_id, &player1);
// player1 is refunded their stake_amount
```

---

### `get_match`

Returns the full `Match` struct for a given match ID.

```rust
pub fn get_match(env: Env, match_id: u64) -> Result<Match, Error>
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `match_id` | `u64` | The ID of the match to retrieve |

**Returns** `Ok(Match)` with the full match data.

**Errors**

| Error | Condition |
|-------|-----------|
| `MatchNotFound` | No match exists for `match_id` |

**Example**

```rust
let m = client.get_match(&match_id);
println!("State: {:?}, Stake: {}", m.state, m.stake_amount);
```

---

### `is_funded`

Returns whether both players have deposited their stakes.

```rust
pub fn is_funded(env: Env, match_id: u64) -> Result<bool, Error>
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `match_id` | `u64` | The ID of the match to check |

**Returns** `Ok(true)` if both players have deposited, `Ok(false)` otherwise.

**Errors**

| Error | Condition |
|-------|-----------|
| `MatchNotFound` | No match exists for `match_id` |

**Example**

```rust
if client.is_funded(&match_id) {
    // Both players have deposited; match is Active
}
```

---

### `get_escrow_balance`

Returns the total token balance currently held in escrow for a match.

```rust
pub fn get_escrow_balance(env: Env, match_id: u64) -> Result<i128, Error>
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `match_id` | `u64` | The ID of the match |

**Returns** `Ok(i128)` — the escrowed amount.

| Deposits Made | State | Return Value |
|---------------|-------|--------------|
| Neither | `Pending` | `0` |
| One player | `Pending` | `stake_amount` |
| Both players | `Active` | `stake_amount × 2` |
| N/A | `Completed` or `Cancelled` | `0` |

**Errors**

| Error | Condition |
|-------|-----------|
| `MatchNotFound` | No match exists for `match_id` |

**Example**

```rust
let balance = client.get_escrow_balance(&match_id);
// Returns 0, stake_amount, or stake_amount * 2
```

---

## Match Lifecycle

```
create_match()
      │
      ▼
  [Pending] ──── cancel_match() ──► [Cancelled]
      │
  deposit() × 2
      │
      ▼
  [Active]
      │
  submit_result()
      │
      ▼
  [Completed]
```

- A match in `Active` or `Completed` state **cannot** be cancelled.
- A match in `Pending` state **cannot** have a result submitted.
- Deposits are only accepted in `Pending` state.

---

## Events

| Topic | Data | Emitted By |
|-------|------|------------|
| `("match", "created")` | `(match_id, player1, player2, stake_amount)` | `create_match` |
| `("match", "deposit")` | `(match_id, player)` | `deposit` |
| `("match", "activated")` | `match_id` | `deposit` (when both deposited) |
| `("match", "completed")` | `(match_id, winner)` | `submit_result` |
| `("match", "cancelled")` | `match_id` | `cancel_match` |
| `("admin", "oracle")` | `new_oracle` | `update_oracle` |
| `("admin", "paused")` | `()` | `pause` |
| `("admin", "unpaused")` | `()` | `unpause` |

---

## Testing

### Running Tests Locally

This contract includes comprehensive unit tests and property-based fuzz tests using [proptest](https://docs.rs/proptest/1.0.0/proptest/). All tests can be run locally with standard Rust tooling.

#### Prerequisites

- Rust 1.88.0 or later
- Soroban SDK and targets installed:
  ```bash
  rustup install 1.88.0
  rustup target add wasm32-unknown-unknown
  ```

#### Run All Tests

```bash
cargo test -p smile4money-escrow --lib
```

#### Run Only Unit Tests

```bash
cargo test -p smile4money-escrow --lib tests:: -- --skip tests_fuzz
```

#### Run Only Fuzz Tests

```bash
cargo test -p smile4money-escrow --lib tests_fuzz
```

#### Run Property-Based Tests with Increased Iterations

By default, proptest runs 256 iterations per test. To increase coverage (useful for finding rare edge cases), set the `PROPTEST_CASES` environment variable:

```bash
PROPTEST_CASES=1000 cargo test -p smile4money-escrow --lib tests_fuzz::prop_
```

#### Run Exhaustive Fuzz Tests Only

The exhaustive fuzz tests exercise exact boundary conditions and known-bad inputs:

```bash
cargo test -p smile4money-escrow --lib tests_fuzz::fuzz_
```

### Fuzz Test Coverage

The fuzz test suite (`src/tests_fuzz.rs`) covers:

#### Stake Amount Validation

- **Valid range**: Tests that amounts in `[MIN_STAKE, MAX_STAKE]` are accepted
- **Below minimum**: Tests that stakes < `MIN_STAKE` are rejected with `StakeTooLow`
- **Above maximum**: Tests that stakes > `MAX_STAKE` are rejected with `StakeTooHigh`
- **Boundaries**: Exact tests for `MIN_STAKE`, `MIN_STAKE-1`, `MAX_STAKE`, `MAX_STAKE+1`, zero, and negative values

#### Game ID Validation

- **Valid IDs**: Tests accept alphanumeric strings, underscores, and hyphens in the range `[1, 64]` bytes
- **Empty strings**: Tests reject empty game IDs with `InvalidGameId`
- **Oversized IDs**: Tests reject game IDs > 64 bytes with `InvalidGameId`
- **Invalid characters**: Tests reject game IDs containing `@`, `#`, `.`, `/`, spaces, null bytes, and other non-alphanumeric characters with `InvalidGameId`
- **Length boundaries**: Exact tests for IDs at `MAX_GAME_ID_LEN`, one over, and one under

#### Address Validation

- **Identical players**: Tests reject `player1 == player2` with `InvalidPlayers`
- **Distinct players**: Tests accept two different valid addresses
- **Zero address**: Implementation already handles zero addresses (XDR-based check in `is_zero_address`)

### CI Integration

All fuzz tests are automatically run in the CI pipeline:

1. **Escrow Fuzz Tests Job** — runs in GitHub Actions on every push to `master` and on all pull requests
   - Property-based tests: 100 iterations per test via `PROPTEST_CASES=100`
   - Exhaustive fuzz tests: All boundary and character validation tests

To view CI test results:

```bash
# Check GitHub Actions: https://github.com/obajecollinsmicheal-cmd/smile4money/actions
```

---

## Security Notes

- **Oracle authorization**: Only the registered oracle address can submit results. The `game_id` must match the one stored at match creation to prevent cross-match result injection.
- **Duplicate game IDs**: Each `game_id` can only be used in one match. Attempting to reuse a `game_id` returns `DuplicateGameId`.
- **Self-match prevention**: `player1` and `player2` must be different addresses.
- **Pause mechanism**: The admin can pause the contract to block `create_match`, `deposit`, and `submit_result` in an emergency. `cancel_match` and read functions remain available while paused.
- **TTL management**: Match storage is extended to ~30 days (518,400 ledgers) on every state-changing operation to prevent premature expiry.
- **Admin-only operations**: `pause`, `unpause`, and `update_oracle` require admin authorization. Non-admin callers receive `Unauthorized`.
