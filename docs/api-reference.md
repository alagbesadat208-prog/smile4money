# API Reference

Complete reference for all smart contract functions, types, and errors.

## Escrow Contract

### Initialization

#### `initialize`

Initialize the escrow contract with oracle, admin, and default token addresses.

**Signature:**
```rust
pub fn initialize(env: Env, oracle: Address, admin: Address, token: Address) -> Result<(), Error>
```

**Parameters:**
- `oracle`: Address of the trusted oracle that may call `submit_result`
- `admin`: Address of the contract administrator (pause/unpause, oracle rotation)
- `token`: Address of the default SEP-41 token contract used for staking

**Behavior:**
- Validates `token` by calling a read-only method on it; panics if not a valid token contract
- Sets the oracle, admin, and token addresses in instance storage
- Initializes match counter to `0`
- Sets paused state to `false`
- Panics if already initialized

**Authorization:** None required (callable once only)

**Errors:**
- Panics with `"Contract already initialized"` if called a second time

---

### Admin Functions

#### `add_token`

Allowlist a SEP-41 token so matches may be created in it.

**Signature:**
```rust
pub fn add_token(env: Env, token: Address, caller: Address) -> Result<(), Error>
```

**Behavior:**
- Probes the token (calls `decimals`) so a typo or non-token address is
  rejected here rather than at a player's deposit
- Sets the allowlist flag for `token`
- Extends TTL to `MATCH_TTL_LEDGERS`
- Emits `("admin", "token_add")` with `(token, admin)`

**Authorization:** Requires admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the admin
- `Error::TokenAlreadyListed`: The token is already allowlisted

**Note:** Allowlisting a token is *not* a statement that it is safe or liquid â€”
only that the admin accepts it as a stake currency. The allowlist exists to
stop an arbitrary caller from pointing the escrow at a contract of their
choosing; the judgement about which currencies to list stays with the admin,
and every change is recorded on-chain.

---

#### `remove_token`

Delist a token so no new matches may be created in it.

**Signature:**
```rust
pub fn remove_token(env: Env, token: Address, caller: Address) -> Result<(), Error>
```

**Behavior:**
- Clears the allowlist flag for `token`
- Emits `("admin", "token_del")` with `(token, admin)`

**In-flight matches are unaffected.** Removal stops *new* matches; it does not
touch matches that already exist. Their escrows remain in that token and still
settle and pay out there, because a player who funded a match must be able to
finish it. This is how an admin delists a currency that turned out to be broken
without stranding funds.

**Authorization:** Requires admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the admin
- `Error::TokenNotListed`: The token was not allowlisted
- `Error::CannotRemoveDefault`: The token is the contract's default

---

#### `is_token_allowlisted`

Read-only check of whether a token is currently accepted.

**Signature:**
```rust
pub fn is_token_allowlisted(env: Env, token: Address) -> bool
```

Allows a frontend to grey out a currency selector without attempting a doomed
`create_match`. The default token is always allowlisted, so this never returns
`false` for it.

---

#### `pause`

Pause the contract to prevent new matches, deposits, and result submissions.

**Signature:**
```rust
pub fn pause(env: Env) -> Result<(), Error>
```

**Behavior:**
- Sets paused flag to `true`
- Blocks `create_match`, `deposit`, and `submit_result`
- `cancel_match` remains available so players can recover funds
- Emits `("admin", "paused")` event

**Authorization:** Requires admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the admin

---

#### `unpause`

Resume normal contract operations.

**Signature:**
```rust
pub fn unpause(env: Env) -> Result<(), Error>
```

**Behavior:**
- Sets paused flag to `false`
- Re-enables all contract functions
- Emits `("admin", "unpaused")` event

**Authorization:** Requires admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the admin

---

#### `update_oracle`

Rotate the trusted oracle address.

**Signature:**
```rust
pub fn update_oracle(env: Env, new_oracle: Address) -> Result<(), Error>
```

**Parameters:**
- `new_oracle`: Replacement oracle address

**Behavior:**
- Replaces the stored oracle address with `new_oracle`
- Emits `("admin", "oracle")` event with the new oracle address

**Authorization:** Requires admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the admin

**Example:**
```rust
escrow.update_oracle(&new_oracle_addr);
```

---

### Match Management

#### `create_match`

Create a new betting match.

**Signature:**
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

**Parameters:**
- `player1`: Address of the match creator (must sign the transaction)
- `player2`: Address of the opponent
- `stake_amount`: Amount each player must deposit (in the token's smallest unit)
- `token`: SEP-41 token for this match. `None` uses the contract's default token.
  A non-`None` value must be on the admin-managed allowlist â€” see
  [Token Allowlist](#token-allowlist).
- `game_id`: Unique identifier from the chess platform (max 64 bytes)
- `platform`: Chess platform enum (`Lichess` or `ChessDotCom`)

**Returns:**
- `u64`: Unique match ID

**Behavior:**
- Validates `stake_amount > 0`
- Validates `player1 != player2`
- Validates `game_id` length is between 1 and 64 bytes
- Rejects duplicate `game_id` values
- Resolves `token`: the explicit argument if given, otherwise the default
- Rejects a token that is not on the allowlist
- Creates match in `Pending` state, recording the resolved token
- Increments match counter with overflow check
- Extends TTL to `MATCH_TTL_LEDGERS` (~30 days)
- Emits `("match", "created")` event

**Authorization:** Requires `player1` signature

**Errors:**
- `Error::ContractPaused`: Contract is paused
- `Error::InvalidAmount`: `stake_amount â‰¤ 0`
- `Error::InvalidPlayers`: `player1 == player2`
- `Error::InvalidGameId`: `game_id` is empty or exceeds 64 bytes
- `Error::DuplicateGameId`: `game_id` is already used in another match
- `Error::TokenNotAllowlisted`: the token is not on the allowlist
- `Error::AlreadyExists`: Match ID collision (internal counter error)
- `Error::Overflow`: Match counter would exceed `u64::MAX`

**Example:**
```rust
// Use the contract's default token
let match_id = escrow.create_match(
    &player1_addr,
    &player2_addr,
    &1_000_0000, // 100 XLM (7 decimals)
    &None,
    &String::from_str(&env, "lichess_abc123"),
    &Platform::Lichess,
);

// Or name an allowlisted token explicitly (e.g. USDC)
let usdc_match = escrow.create_match(
    &player1_addr,
    &player2_addr,
    &100_000000, // 100 USDC (6 decimals)
    &Some(usdc_token_addr),
    &String::from_str(&env, "lichess_def456"),
    &Platform::Lichess,
);
```

> **Breaking change:** `token` was previously a required `Address` that had to
> equal the token from `initialize`. It is now an `Option<Address>`, and any
> allowlisted token is accepted. Existing clients that pass the default token
> must wrap it in `Some(...)`; the contract's own `create_match` name and
> argument order are otherwise unchanged.

---

#### `deposit`

Deposit stake into escrow for a match.

**Signature:**
```rust
pub fn deposit(env: Env, match_id: u64, player: Address) -> Result<(), Error>
```

**Parameters:**
- `match_id`: ID of the match to deposit into
- `player`: Address making the deposit (must be `player1` or `player2`)

**Behavior:**
- Validates match exists and is in `Pending` state
- Validates caller is `player1` or `player2`
- Transfers `stake_amount` tokens from `player` to the contract
- Marks the player as deposited
- If both players have deposited, transitions match to `Active` state and emits `("match", "activated")`
- Extends TTL to `MATCH_TTL_LEDGERS`
- Emits `("match", "deposit")` event

**Authorization:** Requires `player` signature

**Errors:**
- `Error::ContractPaused`: Contract is paused
- `Error::MatchNotFound`: Invalid `match_id`
- `Error::MatchCancelled`: Match has been cancelled
- `Error::MatchCompleted`: Match has already completed
- `Error::InvalidState`: Match is not in `Pending` state
- `Error::Unauthorized`: Caller is not `player1` or `player2`
- `Error::AlreadyFunded`: Player has already deposited
- `Error::TransferFailed`: Token transfer failed

**Example:**
```rust
// Player 1 deposits
escrow.deposit(&match_id, &player1_addr);

// Player 2 deposits â€” match transitions to Active
escrow.deposit(&match_id, &player2_addr);
```

---

#### `cancel_match`

Cancel a pending match and refund any deposits.

**Signature:**
```rust
pub fn cancel_match(env: Env, match_id: u64, caller: Address) -> Result<(), Error>
```

**Parameters:**
- `match_id`: ID of the match to cancel
- `caller`: Address requesting cancellation (must be `player1` or `player2`)

**Behavior:**
- Validates match is in `Pending` state (cancellation is not allowed once `Active`)
- Validates caller is `player1` or `player2`
- If both players have deposited, requires authorization from **both** players
- Refunds `player1` if they deposited
- Refunds `player2` if they deposited
- Transitions to `Cancelled` state
- Extends TTL to `MATCH_TTL_LEDGERS`
- Emits `("match", "cancelled")` event
- Allowed even when the contract is paused (so players can always recover funds)

**Authorization:** Requires `caller` signature; if both players have deposited, requires both `player1` and `player2` signatures

**Errors:**
- `Error::MatchNotFound`: Invalid `match_id`
- `Error::InvalidState`: Match is not `Pending` (already `Active`, `Completed`, or `Cancelled`)
- `Error::Unauthorized`: Caller is not `player1` or `player2`

**Example:**
```rust
// Either player can cancel a pending match
escrow.cancel_match(&match_id, &player2_addr);
```

---

### Result Submission

#### `submit_result`

Submit a verified match result and execute payout.

**Signature:**
```rust
pub fn submit_result(
    env: Env,
    match_id: u64,
    game_id: String,
    winner: Winner,
    caller: Address,
) -> Result<(), Error>
```

**Parameters:**
- `match_id`: ID of the match to finalize
- `game_id`: Chess platform game identifier â€” must match the `game_id` stored in the match record
- `winner`: Result enum (`Player1`, `Player2`, or `Draw`)
- `caller`: Address submitting the result (must be the registered oracle)

**Behavior:**
- Validates `caller` is the trusted oracle address
- Validates `game_id` matches the match's stored `game_id` (prevents cross-match result injection)
- Validates match is in `Active` state
- Validates both players have deposited
- Executes payout based on `winner`:
  - `Player1`: Transfers `stake_amount Ã— 2` to `player1`
  - `Player2`: Transfers `stake_amount Ã— 2` to `player2`
  - `Draw`: Returns `stake_amount` to each player
- Transitions to `Completed` state
- Extends TTL to `MATCH_TTL_LEDGERS`
- Emits `("match", "completed")` event

**Authorization:** Requires oracle signature

**Errors:**
- `Error::ContractPaused`: Contract is paused
- `Error::Unauthorized`: Caller is not the registered oracle
- `Error::MatchNotFound`: Invalid `match_id`
- `Error::GameIdMismatch`: Provided `game_id` does not match the match's stored `game_id`
- `Error::InvalidState`: Match is not `Active`
- `Error::NotFunded`: Both players have not deposited

**Example:**
```rust
// Oracle submits Player1 win
escrow.submit_result(
    &match_id,
    &String::from_str(&env, "lichess_abc123"),
    &Winner::Player1,
    &oracle_addr,
);
```

---

### Fees and Payouts

What a player pays and receives for one match (#112). The frontend shows this breakdown before every wallet approval; the calculation is `apps/frontend/src/utils/payout.ts`.

| Item | Amount | Notes |
|------|--------|-------|
| Stake | `stake_amount`, the same for both players | Transferred into escrow by `deposit` |
| Platform fee | **0** | The escrow contract takes no cut. `PLATFORM_FEE_BPS = 0` in `payout.ts` records this. |
| Win | Gross `2 × stake_amount`, net `+stake_amount` | Paid by `finalize_result` after the dispute window |
| Draw | Gross `stake_amount` to each player, net `0` | Both stakes refunded by `finalize_result` |
| Loss | Gross `0`, net `−stake_amount` | |
| Cancel / timeout | Each player's own stake back | `cancel_match`, `claim_timeout` |
| Network fee | **Estimate only** | See below |

**Network fee.** Each transaction the player signs (`create_match`, a token approval when needed, `deposit`) pays a Stellar fee in XLM from the signer's balance. It is never taken out of the stake or the payout.

The fee is the inclusion fee (at least 100 stroops) plus a Soroban resource fee. The resource fee is only known once the wallet simulates the transaction, and it depends on network prices at that moment.

The UI shows an upper estimate per step:

```
100 stroops + VITE_ESTIMATED_RESOURCE_FEE_STROOPS (default 500,000 stroops = 0.05 XLM)
```

The UI labels it as an estimate and tells the player that the wallet shows the exact fee before approval. Never present it as exact. Set `VITE_ESTIMATED_RESOURCE_FEE_STROOPS` per deployment if observed fees differ.

If the contract ever takes a platform fee, update `PLATFORM_FEE_BPS` and this table in the same change as the contract.

### Query Functions

#### `get_match`

Retrieve full match details.

**Signature:**
```rust
pub fn get_match(env: Env, match_id: u64) -> Result<Match, Error>
```

**Parameters:**
- `match_id`: ID of the match to query

**Returns:**
- `Match`: Complete match struct

**Errors:**
- `Error::MatchNotFound`: Invalid `match_id`

**Example:**
```rust
let match_data = escrow.get_match(&match_id);
assert_eq!(match_data.state, MatchState::Active);
```

---

#### `is_funded`

Check if both players have deposited.

**Signature:**
```rust
pub fn is_funded(env: Env, match_id: u64) -> Result<bool, Error>
```

**Parameters:**
- `match_id`: ID of the match to check

**Returns:**
- `bool`: `true` if both players have deposited, `false` otherwise

**Errors:**
- `Error::MatchNotFound`: Invalid `match_id`

**Example:**
```rust
if escrow.is_funded(&match_id) {
    // Match is ready to start
}
```

---

#### `get_escrow_balance`

Get total tokens held in escrow for a match.

**Signature:**
```rust
pub fn get_escrow_balance(env: Env, match_id: u64) -> Result<i128, Error>
```

**Parameters:**
- `match_id`: ID of the match to check

**Returns:**
- `i128`: Total escrowed amount (`0`, `stake_amount`, or `2 Ã— stake_amount`)

**Behavior:**
- Returns `0` if match is `Completed` or `Cancelled`
- Returns `stake_amount` if exactly one player has deposited
- Returns `2 Ã— stake_amount` if both players have deposited

**Errors:**
- `Error::MatchNotFound`: Invalid `match_id`

**Example:**
```rust
let balance = escrow.get_escrow_balance(&match_id);
// 0, stake_amount, or 2 * stake_amount
```

---

#### `list_matches`

Retrieve a paginated list of match IDs.

**Signature:**
```rust
pub fn list_matches(env: Env, start: u64, limit: u32) -> Vec<u64>
```

**Parameters:**
- `start`: Match ID to start from (inclusive)
- `limit`: Maximum number of match IDs to return (capped at 100)

**Returns:**
- `Vec<u64>`: Vector of match IDs from `start` up to the next 100 entries (or fewer)

**Behavior:**
- Returns match IDs in range `[start, start + limit)` where the limit is automatically capped at **100**
- If `start >= total_match_count`, returns an empty vector (last page)
- If fewer matches exist between `start` and `start + limit`, only returns available IDs
- Empty return indicates the last page has been reached

**Pagination Example:**
```rust
let mut start = 0;
loop {
    let matches = escrow.list_matches(&start, &100);
    if matches.is_empty() {
        break; // Reached the last page
    }
    
    // Process matches...
    for match_id in &matches {
        let match_data = escrow.get_match(match_id);
        println!("Match {}: {:?}", match_id, match_data.state);
    }
    
    // Advance to next page
    start = start + matches.len() as u64;
}
```

**Notes:**
- Requesting a `limit` greater than 100 does not error; it is silently capped at 100
- To detect the last page: if the returned vector has fewer entries than requested, you have reached the end
- All match IDs are returned sequentially (0, 1, 2, ...) regardless of state

---

#### `list_matches_after`

Retrieve a paginated list of match IDs using **cursor-based** (keyset) pagination, a more robust alternative to `list_matches`.

**Signature:**
```rust
pub fn list_matches_after(env: Env, after_match_id: u64, limit: u32) -> Vec<u64>
```

**Parameters:**
- `after_match_id`: Return IDs strictly greater than this value. Use `u64::MAX` to start from the beginning.
- `limit`: Maximum number of match IDs to return (capped at 100)

**Returns:**
- `Vec<u64>`: Vector of match IDs greater than `after_match_id`, up to `limit` entries

**Behavior:**
- Returns IDs in the range `(after_match_id, after_match_id + limit]` (capped at 100 iterations)
- **Unambiguous end-of-data**: an empty result always means there are no further matches. Unlike offset-based `list_matches`, a sparse ID space cannot produce a false "gap"
- Cursor reuse is safe: the same cursor remains valid even if the contract state changes between calls
- If fewer matches exist after the cursor, only the available IDs are returned

**Pagination Example:**
```rust
let mut cursor = u64::MAX; // start before all IDs
loop {
    let matches = escrow.list_matches_after(&cursor, &100);
    if matches.is_empty() {
        break; // Reached the end of data
    }

    // Process matches...
    for match_id in &matches {
        let match_data = escrow.get_match(match_id);
        println!("Match {}: {:?}", match_id, match_data.state);
    }

    // Advance the cursor using the last returned ID
    cursor = matches.get(matches.len() - 1);
}
```

**Notes:**
- Prefer this function over `list_matches` when iterating matches in sparse ID spaces (e.g. many cancelled matches), since it never misses entries
- Requesting a `limit` greater than 100 does not error; it is silently capped at 100
- To detect the last page: an empty vector indicates the end of data

---

#### `list_results`

Retrieve a paginated list of oracle results.

**Signature:**
```rust
pub fn list_results(env: Env, start: u64, limit: u32) -> Vec<(u64, ResultEntry)>
```

**Parameters:**
- `start`: Match ID to start searching from (inclusive)
- `limit`: Maximum number of results to return (capped at 100)

**Returns:**
- `Vec<(u64, ResultEntry)>`: Vector of tuples containing `(match_id, result_entry)` for matches with submitted results

**Behavior:**
- Scans match IDs starting from `start` up to `start + limit` (capped at 100 iterations)
- Only returns entries where a result has been submitted via `submit_result`
- If no results exist in the scanned range, returns an empty vector
- Unlike `list_matches`, the returned vector may be **shorter than the limit** because skipped IDs (those without results) are not included

**Pagination Example:**
```rust
let mut start = 0;
let mut all_results = Vec::new();
loop {
    let results = oracle.list_results(&start, &100);
    if results.is_empty() {
        break; // No results found in this range, stop scanning
    }
    
    // Process results...
    for (match_id, entry) in &results {
        println!("Match {}: {} -> {:?}", match_id, entry.game_id, entry.result);
    }
    
    // Advance scan position by 100 (not by results.len(), since results can be sparse)
    start = start + 100;
}
```

**Important Differences from list_matches:**
- `list_results` scans up to 100 match IDs but returns only those with submitted results
- A page may return fewer entries than the cap (empty matches are skipped)
- To iterate through all results without gaps, always advance `start` by 100, not by `results.len()`
- Requesting a `limit` greater than 100 does not error; it is silently capped at 100

---

## Oracle Contract

### Initialization

#### `initialize`

Initialize the oracle contract with the admin address.

**Signature:**
```rust
pub fn initialize(env: Env, admin: Address) -> Result<(), Error>
```

**Parameters:**
- `admin`: Address of the oracle service (the only address that may call `submit_result`)

**Behavior:**
- Sets the admin address in instance storage
- Emits `("oracle", "init")` event with the admin address
- Returns `Error::AlreadyInitialized` if called a second time

**Authorization:** None required (callable once only)

**Errors:**
- `Error::AlreadyInitialized`: Contract has already been initialized

---

### Result Management

#### `submit_result`

Submit a verified match result on-chain.

**Signature:**
```rust
pub fn submit_result(
    env: Env,
    match_id: u64,
    game_id: String,
    result: MatchResult,
) -> Result<(), Error>
```

**Parameters:**
- `match_id`: ID of the match (from the escrow contract)
- `game_id`: Chess platform game identifier (max 64 bytes, must be non-empty)
- `result`: Result enum (`Player1Wins`, `Player2Wins`, or `Draw`)

**Behavior:**
- Validates caller is the admin
- Validates `game_id` is non-empty and at most 64 bytes
- Prevents duplicate submissions for the same `match_id`
- Stores `ResultEntry` in persistent storage with TTL extension
- Emits `("oracle", "result")` event with `(match_id, result, timestamp)`

**Authorization:** Requires admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the admin
- `Error::InvalidGameId`: `game_id` is empty or exceeds 64 bytes
- `Error::AlreadySubmitted`: A result already exists for this `match_id`

**Example:**
```rust
oracle.submit_result(
    &match_id,
    &String::from_str(&env, "lichess_abc123"),
    &MatchResult::Player1Wins,
);
```

---

#### `get_result`

Retrieve the stored result for a match.

**Signature:**
```rust
pub fn get_result(env: Env, match_id: u64) -> Result<ResultEntry, Error>
```

**Parameters:**
- `match_id`: ID of the match to query

**Returns:**
- `ResultEntry`: Struct containing `game_id` and `result`

**Errors:**
- `Error::ResultNotFound`: No result has been submitted for this `match_id`

**Example:**
```rust
let entry = oracle.get_result(&match_id);
assert_eq!(entry.result, MatchResult::Player1Wins);
```

---

#### `has_result`

Check if a result exists for a match.

**Signature:**
```rust
pub fn has_result(env: Env, match_id: u64) -> bool
```

**Parameters:**
- `match_id`: ID of the match to check

**Returns:**
- `bool`: `true` if a result has been submitted, `false` otherwise

**Example:**
```rust
if oracle.has_result(&match_id) {
    let entry = oracle.get_result(&match_id);
}
```

---

#### `transfer_admin`

Transfer oracle admin rights to a new address.

**Signature:**
```rust
pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error>
```

**Parameters:**
- `new_admin`: Address of the new admin

**Behavior:**
- Replaces the stored admin address with `new_admin`
- Emits `("oracle", "adm_xfer")` event with `(old_admin, new_admin)`

**Authorization:** Requires current admin signature

**Errors:**
- `Error::Unauthorized`: Caller is not the current admin

**Example:**
```rust
oracle.transfer_admin(&new_oracle_service_addr);
```

---

## Data Types

### Match

Complete match record stored in the escrow contract.

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
    pub created_ledger: u32,
}
```

**Fields:**
- `id`: Unique match identifier (auto-assigned)
- `player1`: Match creator address
- `player2`: Opponent address
- `stake_amount`: Amount each player deposits (in token's smallest unit)
- `token`: SEP-41 token contract address
- `game_id`: Chess platform game identifier
- `platform`: Chess platform (`Lichess` or `ChessDotCom`)
- `state`: Current match lifecycle state
- `player1_deposited`: Whether `player1` has deposited
- `player2_deposited`: Whether `player2` has deposited
- `created_ledger`: Ledger sequence number at match creation

---

### MatchState

Match lifecycle states.

```rust
pub enum MatchState {
    Pending,   // Created, awaiting both deposits
    Active,    // Both players deposited, game in progress
    Completed, // Result submitted, payout executed (terminal)
    Cancelled, // Cancelled before activation (terminal)
}
```

---

### Platform

Supported chess platforms.

```rust
pub enum Platform {
    Lichess,
    ChessDotCom,
}
```

---

### Winner

Match outcome for the escrow contract's `submit_result`.

```rust
pub enum Winner {
    Player1, // Player1 receives stake_amount Ã— 2
    Player2, // Player2 receives stake_amount Ã— 2
    Draw,    // Each player receives their original stake_amount
}
```

---

### MatchResult

Match outcome for the oracle contract's `submit_result`.

```rust
pub enum MatchResult {
    Player1Wins,
    Player2Wins,
    Draw,
}
```

---

### ResultEntry

Oracle result record stored in the oracle contract.

```rust
pub struct ResultEntry {
    pub game_id: String,
    pub result: MatchResult,
}
```

---

## Error Codes

### Escrow Contract Errors

```rust
pub enum Error {
    MatchNotFound      = 1,  // No match exists for the given match_id
    AlreadyFunded      = 2,  // Player has already deposited for this match
    NotFunded          = 3,  // submit_result called before both players deposited
    Unauthorized       = 4,  // Caller lacks required authorization
    InvalidState       = 5,  // Operation not allowed in the current match state
    AlreadyExists      = 6,  // Match ID collision (internal counter error)
    AlreadyInitialized = 7,  // Contract already initialized (unused; initialize panics instead)
    Overflow           = 8,  // Match counter would exceed u64::MAX
    ContractPaused     = 9,  // Contract is paused; mutating operations are blocked
    InvalidAmount      = 10, // stake_amount â‰¤ 0
    InvalidGameId      = 11, // game_id is empty or exceeds 64 bytes
    InvalidPlayers     = 12, // player1 == player2 in create_match
    GameIdMismatch     = 13, // Oracle submitted result for the wrong game_id
    DuplicateGameId    = 14, // game_id is already linked to another match
    TransferFailed     = 15, // Token transfer failed
    MatchCancelled     = 16, // Deposit rejected â€” match has been cancelled
    MatchCompleted     = 17, // Deposit rejected — match has already completed
    InvalidToken      = 22, // Token does not match the configured default (legacy; see E028)
    InvalidAdmin      = 23, // New admin address is invalid
    StakeTooLow       = 24, // stake_amount below MIN_STAKE
    StakeTooHigh      = 25, // stake_amount above MAX_STAKE
    InsufficientReserve = 26, // Balance too low to cover payout + minimum reserve
    InvalidAddress    = 27, // A player address is the zero/burn address
    TokenNotAllowlisted = 28, // Token is not on the admin-managed allowlist
    TokenAlreadyListed  = 29, // add_token called for an already-allowlisted token
    TokenNotListed      = 30, // remove_token called for a token that is not allowlisted
    CannotRemoveDefault = 31, // remove_token called for the contract default token
}
}
```

### Oracle Contract Errors

```rust
pub enum Error {
    Unauthorized       = 1, // Caller is not the admin
    AlreadySubmitted   = 2, // A result already exists for this match_id
    ResultNotFound     = 3, // No result submitted for this match_id
    AlreadyInitialized = 4, // Contract already initialized
    InvalidGameId      = 5, // game_id is empty or exceeds 64 bytes
    TransferFailed     = 6, // Token transfer failed
    InvalidAmount      = 7, // withdraw amount must be > 0
}
```

---

## Events

### Escrow Contract Events

#### `("match", "created")`
Emitted when a new match is created via `create_match`.

**Data:** `(match_id: u64, player1: Address, player2: Address, stake_amount: i128, game_id: String)`

---

#### `("match", "activated")`
Emitted when both players have deposited and the match transitions to `Active`.

**Data:** `match_id: u64`

---

#### `("match", "deposit")`
Emitted on every individual player deposit.

**Data:** `(match_id: u64, player: Address, stake_amount: i128)`

---

#### `("match", "completed")`
Emitted when the oracle submits a result and the payout is executed.

**Data:** `(match_id: u64, winner: Winner, payout_amount: i128)`

---

#### `("match", "cancelled")`
Emitted when a match is cancelled via `cancel_match`.

**Data:** `(match_id: u64, caller: Address)`

---

#### `("admin", "paused")`
Emitted when the contract is paused.

**Data:** `()`

---

#### `("admin", "unpaused")`
Emitted when the contract is unpaused.

**Data:** `()`

---

#### `("admin", "oracle")`
Emitted when the oracle address is rotated via `update_oracle`.

**Data:** `new_oracle: Address`

---

### Oracle Contract Events

#### `("oracle", "init")`
Emitted when the oracle contract is initialized.

**Data:** `admin: Address`

---

#### `("oracle", "result")`
Emitted when a result is submitted via `submit_result`.

**Data:** `(match_id: u64, result: MatchResult, timestamp: u64)`

---

#### `("oracle", "adm_xfer")`
Emitted when admin rights are transferred via `transfer_admin`.

**Data:** `(old_admin: Address, new_admin: Address)`

---

## Constants

Every ledger duration and identifier limit is defined **once** in
`contracts/smile4money-common/src/constants.rs` and re-exported by each contract's own
`constants` module, so the escrow and oracle contracts can never drift apart. The
TypeScript mirror of the same values is `apps/frontend/src/constants.ts`.

Each constant carries a doc comment citing its source (Stellar documentation, or the
ADR that decided the policy).

### Shared (escrow + oracle)

`contracts/escrow/src/constants.rs`, `contracts/oracle/src/constants.rs`

```rust
pub const SECONDS_PER_LEDGER: u32   = 5;         // ~5 s/ledger (Stellar network target)
pub const LEDGERS_PER_DAY: u32      = 17_280;    // 86_400 / 5
pub const LEDGERS_PER_WEEK: u32     = 120_960;   // 604_800 / 5
pub const MATCH_TTL_LEDGERS: u32    = 518_400;   // ~30 days
pub const DISPUTE_WINDOW_LEDGERS: u32 = LEDGERS_PER_DAY; // ~24 hours (ADR-001)
pub const TIMEOUT_LEDGERS: u32      = LEDGERS_PER_WEEK;  // ~7 days (ADR-001)
pub const MAX_GAME_ID_LEN: u32      = 64;        // Maximum game_id byte length
```

### Escrow only

`contracts/escrow/src/constants.rs`

```rust
pub const MIN_STAKE: i128               = 1;
pub const MAX_STAKE: i128               = 10_000_000_000_000;
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = MATCH_TTL_LEDGERS;
pub const INSTANCE_BUMP_AMOUNT: u32       = MATCH_TTL_LEDGERS;
pub const ESCROW_RESERVE_BUFFER_STROOPS: i128 = 15_000_000; // 1.5 XLM
```

### Oracle only

`contracts/oracle/src/constants.rs`

```rust
pub const MAX_LIST_LIMIT: u32 = 100;
```

---

## Soroban CLI Invocations

All examples below assume the following environment variables are set:

```bash
export NETWORK=testnet
export CONTRACT_ESCROW=<escrow-contract-id>
export CONTRACT_ORACLE=<oracle-contract-id>
export TOKEN_ADDRESS=<sep41-token-contract-id>
export ADMIN_ADDRESS=<admin-stellar-address>
export ORACLE_ADDRESS=<oracle-stellar-address>
export PLAYER1_ADDRESS=<player1-stellar-address>
export PLAYER2_ADDRESS=<player2-stellar-address>
```

### Escrow Contract CLI Examples

#### initialize

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network "$NETWORK" \
  -- initialize \
  --oracle "$ORACLE_ADDRESS" \
  --admin "$ADMIN_ADDRESS" \
  --token "$TOKEN_ADDRESS"
```

#### pause

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network "$NETWORK" \
  -- pause
```

#### unpause

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network "$NETWORK" \
  -- unpause
```

#### update_oracle

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network "$NETWORK" \
  -- update_oracle \
  --new_oracle "$NEW_ORACLE_ADDRESS"
```

#### create_match

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source player1-key \
  --network "$NETWORK" \
  -- create_match \
  --player1 "$PLAYER1_ADDRESS" \
  --player2 "$PLAYER2_ADDRESS" \
  --stake_amount 1000000000 \
  --token "$TOKEN_ADDRESS" \
  --game_id "lichess_abc123" \
  --platform '{"Lichess":{}}'
# Returns: u64 match_id
```

For Chess.com:

```bash
  --platform '{"ChessDotCom":{}}'
```

#### deposit

```bash
# Player 1 deposits
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source player1-key \
  --network "$NETWORK" \
  -- deposit \
  --match_id 0 \
  --player "$PLAYER1_ADDRESS"

# Player 2 deposits (match transitions to Active after this)
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source player2-key \
  --network "$NETWORK" \
  -- deposit \
  --match_id 0 \
  --player "$PLAYER2_ADDRESS"
```

#### cancel_match

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source player2-key \
  --network "$NETWORK" \
  -- cancel_match \
  --match_id 0 \
  --caller "$PLAYER2_ADDRESS"
```

#### submit_result (escrow)

```bash
# Player 1 wins
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source oracle-key \
  --network "$NETWORK" \
  -- submit_result \
  --match_id 0 \
  --game_id "lichess_abc123" \
  --winner '{"Player1":{}}' \
  --caller "$ORACLE_ADDRESS"

# Player 2 wins
  --winner '{"Player2":{}}'

# Draw
  --winner '{"Draw":{}}'
```

#### emergency_drain

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network "$NETWORK" \
  -- emergency_drain \
  --to "$SAFE_COLD_WALLET_ADDRESS" \
  --caller "$ADMIN_ADDRESS"
```

#### get_match

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source any-key \
  --network "$NETWORK" \
  -- get_match \
  --match_id 0
```

#### is_funded

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source any-key \
  --network "$NETWORK" \
  -- is_funded \
  --match_id 0
# Returns: true | false
```

#### get_escrow_balance

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source any-key \
  --network "$NETWORK" \
  -- get_escrow_balance \
  --match_id 0
# Returns: i128 (0, stake_amount, or 2 * stake_amount)
```

#### list_matches

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source any-key \
  --network "$NETWORK" \
  -- list_matches \
  --start 0 \
  --limit 100
# Returns: Vec<u64> of match IDs [0, 1, 2, ...]
```

Example with pagination loop (in bash):

```bash
# Fetch all matches in pages
start=0
while true; do
  matches=$(stellar contract invoke \
    --id "$CONTRACT_ESCROW" \
    --source any-key \
    --network "$NETWORK" \
    -- list_matches \
    --start $start \
    --limit 100)
  
  # Check if empty (reached last page)
  if [ -z "$matches" ] || [ "$matches" = "[]" ]; then
    break
  fi
  
  # Process matches...
  echo "Matches from $start: $matches"
  
  # Advance by the number of results
  count=$(echo "$matches" | jq 'length')
  start=$((start + count))
done
```

#### list_results

```bash
stellar contract invoke \
  --id "$CONTRACT_ORACLE" \
  --source any-key \
  --network "$NETWORK" \
  -- list_results \
  --start 0 \
  --limit 100
# Returns: Vec<(u64, ResultEntry)> of (match_id, result_entry) pairs
```

Example with pagination loop (in bash):

```bash
# Fetch all results in pages
start=0
while true; do
  results=$(stellar contract invoke \
    --id "$CONTRACT_ORACLE" \
    --source any-key \
    --network "$NETWORK" \
    -- list_results \
    --start $start \
    --limit 100)
  
  # Check if empty (no results in this range)
  if [ -z "$results" ] || [ "$results" = "[]" ]; then
    break
  fi
  
  # Process results...
  echo "Results from match $start: $results"
  
  # Always advance by 100, not by results.len()
  # (results can be sparse if some matches don't have results yet)
  start=$((start + 100))
done
```

---

### Oracle Contract CLI Examples

#### initialize (oracle)

```bash
stellar contract invoke \
  --id "$CONTRACT_ORACLE" \
  --source admin-key \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ORACLE_ADDRESS"
```

#### submit_result (oracle)

```bash
stellar contract invoke \
  --id "$CONTRACT_ORACLE" \
  --source oracle-key \
  --network "$NETWORK" \
  -- submit_result \
  --match_id 0 \
  --game_id "lichess_abc123" \
  --result '{"Player1Wins":{}}'

# Other result variants:
  --result '{"Player2Wins":{}}'
  --result '{"Draw":{}}'
```

#### get_result

```bash
stellar contract invoke \
  --id "$CONTRACT_ORACLE" \
  --source any-key \
  --network "$NETWORK" \
  -- get_result \
  --match_id 0
# Returns: ResultEntry { game_id, result }
```

#### has_result

```bash
stellar contract invoke \
  --id "$CONTRACT_ORACLE" \
  --source any-key \
  --network "$NETWORK" \
  -- has_result \
  --match_id 0
# Returns: true | false
```

#### transfer_admin (oracle)

```bash
stellar contract invoke \
  --id "$CONTRACT_ORACLE" \
  --source oracle-key \
  --network "$NETWORK" \
  -- transfer_admin \
  --new_admin "$NEW_ORACLE_ADDRESS"
```

---

> **Keeping this document in sync:** When adding or changing a public contract function,
> update this file in the same PR. The PR template includes a checklist item for this.

## Usage Examples

### Complete Match Flow

```rust
// 1. Initialize contracts
escrow.initialize(&oracle_addr, &admin_addr, &xlm_token_addr);
oracle.initialize(&oracle_service_addr);

// 2. Create match
let match_id = escrow.create_match(
    &player1,
    &player2,
    &100_0000000, // 100 XLM (7 decimals)
    &xlm_token,
    &String::from_str(&env, "lichess_game123"),
    &Platform::Lichess,
);

// 3. Players deposit
escrow.deposit(&match_id, &player1);
escrow.deposit(&match_id, &player2); // match transitions to Active

// 4. Verify match is funded
assert!(escrow.is_funded(&match_id));

// 5. Players play the chess game...

// 6. Oracle records result on-chain
oracle.submit_result(
    &match_id,
    &String::from_str(&env, "lichess_game123"),
    &MatchResult::Player1Wins,
);

// 7. Oracle triggers payout on escrow
escrow.submit_result(
    &match_id,
    &String::from_str(&env, "lichess_game123"),
    &Winner::Player1,
    &oracle_addr,
);

// 8. Verify completion
let match_data = escrow.get_match(&match_id);
assert_eq!(match_data.state, MatchState::Completed);
```

### Cancellation Flow

```rust
// Create match
let match_id = escrow.create_match(...);

// Player1 deposits
escrow.deposit(&match_id, &player1);

// Player2 decides not to play â€” cancels and player1 is refunded
escrow.cancel_match(&match_id, &player2);
```

### Emergency Pause

```rust
// Admin pauses contract
escrow.pause();

// All mutating operations are blocked
assert!(escrow.try_create_match(...).is_err()); // Error::ContractPaused

// cancel_match still works so players can recover funds
escrow.cancel_match(&match_id, &player1);

// Admin unpauses
escrow.unpause();

// Operations resume normally
```

### Oracle Admin Rotation

```rust
// Transfer oracle admin to a new key
oracle.transfer_admin(&new_oracle_service_addr);

// Old admin can no longer submit results
// New admin can submit results immediately
oracle.submit_result(&match_id, &game_id, &MatchResult::Draw);
```

## Backend REST API

The off-chain backend (`apps/backend`) exposes `POST /api/matches`, `POST /api/oracle/submit-result`, `POST /api/validate-game`, and `GET /health`. This section documents its error response contract; see `docs/oracle.md` for the off-chain oracle's design.

### Error Response Schema

Every error response from the backend API follows the same envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "gameId is required"
  }
}
```

- `error.code` — a stable, machine-readable string. API consumers should branch on this, not on `error.message` (which is meant for humans and may be reworded).
- `error.message` — a human-readable description of what went wrong.

Some error responses include additional fields inside `error` (e.g. `error.hint`) for extra machine-readable context, but `code` and `message` are always present.

`/api/validate-game`'s failure responses are the one exception: because that endpoint's job is to report on a game's validity as a normal (non-exceptional) outcome, its `valid`/`platform`/`gameId`/`message` fields are also present at the top level alongside `error`, for backward compatibility with existing consumers of that specific endpoint.

### Error Codes

| Code | HTTP Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | The request body or its fields are missing, malformed, or fail a business rule. |
| `UNAUTHORIZED` | 401 | The `Authorization` header is missing, malformed, or the JWT is invalid/expired. |
| `NOT_FOUND` | 404 | The referenced resource (a match, a game on the upstream chess platform) does not exist. |
| `CONFLICT` | 409 | The request conflicts with existing state (e.g. a duplicate `gameId`). |
| `RATE_LIMITED` | 429 | The caller has exceeded the endpoint's rate limit. |
| `INTERNAL_ERROR` | 500 | An unexpected server-side failure. |

This mapping lives in `apps/backend/src/errors/errorResponse.ts` (`ErrorCode`, `errorEnvelope`, `statusToErrorCode`) — that module is the source of truth if this table and the code ever disagree.

### Example

```bash
curl -s -X POST http://localhost:4000/api/matches \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "player2 is required"
  }
}
```

# Settlement evidence retention

The backend stores a sanitized canonical record for every fetched game record
evaluated by the oracle in the private `settlement_evidence` SQLite table. It contains the
match and game identifiers, platform, normalized player names, normalized
outcome/status, parser version, evaluation timestamp, and decision (verified,
player identity mismatch, or identity hash mismatch). Each evaluation is appended
so a later retry cannot overwrite an earlier decision. Provider response
bodies, PGNs, IP addresses, and unrelated account data are not retained. The
backend deletes evidence older than 30 days at startup and every 24 hours; this matches the
repository's 30-day match retention policy. The database file is owner-readable
only on POSIX systems, and no HTTP route exposes evidence records. Operators
must restrict host and backup access to the backend service account and apply
the same 30-day deletion period to database backups.

## Wallet identity link proof

An authenticated wallet can request a challenge with
`POST /api/player-identity/challenge` and `{ "platform": "lichess",
"username": "alice" }`. The response includes a message bound to that wallet,
platform, username, and a random nonce. Publish the returned `profileProof` in
the chess account's public profile bio (Lichess) or location field (Chess.com).
Sign the SHA-256 digest of the exact UTF-8 message with the wallet's Ed25519
key, then send `{ "nonce": "…",
"signature": "<128 hex characters>" }` to `POST /api/player-identity/confirm`.
Challenges expire after five minutes and a valid proof can be consumed once.
