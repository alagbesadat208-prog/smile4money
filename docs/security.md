# Threat Model & Security

## System Actors and Trust Boundaries

| Actor | Role | Trust Boundary |
|-------|------|----------------|
| **Player 1 / Player 2** | Create matches, deposit stakes, cancel matches | Authenticated by Stellar keypair. Trusted for own key management. Not trusted to act honestly toward each other. |
| **Oracle** | Submits verified game results from Lichess/Chess.com | Authenticated by oracle keypair. Trusted for accurate result reporting. Not trusted with custody of funds. |
| **Admin** | Pause/unpause contract, rotate oracle address, trigger emergency drain | Authenticated by admin keypair. Trusted for emergency operations. Cannot redirect escrowed funds to an arbitrary address — `emergency_drain` always transfers to the `safe_address` fixed at initialization time. |
| **Lichess / Chess.com API** | External source of truth for game outcomes | Outside the Soroban runtime boundary. Trusted to return correct results (within the oracle's verification logic). |
| **Stellar / Soroban runtime** | Executes contract code, enforces authorization | Fully trusted for correct execution, state isolation, and ledger security. |

### Trust Boundary Diagram

```
  [Player 1] ──auth──┐
                      ├──► [Escrow Contract] ◄── [Oracle] ◄── [Lichess API]
  [Player 2] ──auth──┘                              │             └── [Chess.com API]
                                                    │
                                              [Admin key]
```

- **Boundary A** (Player → Contract): Authentication via `require_auth()`. Players cannot impersonate each other.
- **Boundary B** (Oracle → Contract): Authentication via stored oracle address. Only the registered oracle may submit results.
- **Boundary C** (Admin → Contract): Authentication via stored admin address. Admin controls emergency functions only.
- **Boundary D** (External API → Oracle): Off-chain. Oracle is trusted to verify API responses before submitting on-chain.

---

## STRIDE Threat Model

### Spoofing

| Threat | Target | Risk | Mitigation |
|--------|--------|------|------------|
| Attacker impersonates a player to deposit or cancel | `deposit`, `cancel_match` | Medium | `player.require_auth()` enforces Stellar signature verification |
| Attacker impersonates the oracle to submit fraudulent results | `submit_result` | **High** | Oracle address stored in contract; `caller.require_auth()` + comparison against stored address |
| Attacker impersonates the admin to pause or rotate oracle | `pause`, `unpause`, `update_oracle` | Medium | `admin.require_auth()` enforced on each admin function |

### Tampering

| Threat | Target | Risk | Mitigation |
|--------|--------|------|------------|
| Oracle submits result for wrong match_id | `submit_result` | Medium | `game_id` parameter cross-checked against stored `game_id` in match record |
| Oracle submits duplicate result to double-payout | `submit_result` | **High** | State machine rejects `submit_result` when `state != Active`; `Completed` is terminal |
| Attacker creates multiple matches with same game_id | `create_match` | Medium | `DataKey::GameId` tracked; duplicate game_id returns `DuplicateGameId` error |
| Admin drains funds without pause precondition | `emergency_drain` | Medium | `NotPaused` error if contract is not paused; event emitted for transparency |
| Admin (or compromised admin key) drains funds to an arbitrary address (rug-pull) | `emergency_drain` | **High** | **Mitigated (issue #1102).** The `to` parameter has been removed. `emergency_drain` now always transfers to the `safe_address` registered immutably at `initialize` time. A compromised or malicious admin cannot redirect the drain to an attacker-controlled address. |

### Repudiation

| Threat | Target | Risk | Mitigation |
|--------|--------|------|------------|
| Player denies having deposited | `deposit` | Low | On-chain events (`match:deposit`) record player address, match_id, and amount |
| Oracle denies having submitted a result | `submit_result` | Low | On-chain events (`match:completed`) record winner, match_id, and payout amount |
| Admin denies having paused or drained | `pause`, `emergency_drain` | Low | On-chain events (`admin:paused`, `admin:drain`) record the action |

### Information Disclosure

| Threat | Target | Risk | Mitigation |
|--------|--------|------|------------|
| Attacker reads all match data including player addresses | `get_match`, `is_funded`, `get_escrow_balance` | Low | All match state is public by design on Stellar; no confidential data is stored |

### Denial of Service

| Threat | Target | Risk | Mitigation |
|--------|--------|------|------------|
| Attacker creates many matches to fill storage | `create_match` | Low | Each match requires player1 auth; cost of storage is a deterrent; no DoS vector identified |
| Attacker front-runs match creation with duplicate game_id | `create_match` | Low | The legitimate creator can choose a unique or unpredictably long game_id string |
| Oracle never submits a result, locking funds in Active state | `submit_result` | Medium | Players can cancel only while Pending, not Active. **Known limitation**: no auto-timeout exists; a future enhancement should add a timeout-based cancellation. |
| Admin never unpauses after emergency | `unpause` | Low | Admin is a trusted party; governance processes should handle key loss scenarios |

### Elevation of Privilege

| Threat | Target | Risk | Mitigation |
|--------|--------|------|------------|
| Non-oracle address calls submit_result | `submit_result` | **High** | Caller verified against stored oracle address before any state change |
| Non-admin calls pause/unpause/drain | `pause`, `unpause`, `emergency_drain` | **High** | Admin address verified via `require_auth()` |
| Non-player deposits into or cancels a match | `deposit`, `cancel_match` | Medium | `player == m.player1 \|\| player == m.player2` enforced |

---

## Trust Assumptions

| Actor | Trusted for | Not trusted for |
|-------|-------------|-----------------|
| Stellar network | Correct execution of Soroban contracts | — |
| Oracle service | Accurate game result reporting | Custody of player funds |
| Admin key | Pause/unpause, oracle rotation, emergency drain to pre-registered safe address | Redirecting escrowed funds to an arbitrary address (structurally prevented — `emergency_drain` destination is fixed at init time) |
| Players | Their own key management | Each other |

No single party can unilaterally redirect escrowed funds to an arbitrary address. `emergency_drain` is constrained to a pre-registered `safe_address` fixed at deployment. All other payout rules are enforced on-chain by the state machine.

---

## Detailed Risk Analysis

### Oracle Key Compromise

| Attribute | Assessment |
|-----------|------------|
| **Impact** | **Critical**. An attacker with the oracle key can call `submit_result` on any Active match, directing the entire pot to any winner (including Player1 or Player2 arbitrarily). The contract has no on-chain mechanism to distinguish a legitimate oracle submission from a compromised one. |
| **Likelihood** | **Low to Medium**. The oracle key is held by a centralized service. The risk depends on the security posture of the oracle infrastructure (HSM, key rotation, access controls). |
| **Mitigations** | |
| | 1. **Key rotation**: Admin can call `update_oracle()` to replace the compromised key with a new one. This does not revert past submissions but prevents further damage. |
| | 2. **Separation of duties**: Oracle key and admin key are separate. A single compromise cannot both submit results and rotate the oracle key. |
| | 3. **Event monitoring**: Every `submit_result` emits a `match:completed` event. Monitoring infrastructure can detect anomalous submissions. |
| | 4. **Future enhancement**: Multi-sig oracle (M-of-N) so a single key compromise does not permit result submission. |
| **Recovery** | 1. Admin calls `pause()` to block all state-changing operations. 2. Admin calls `update_oracle()` with a new, uncompromised key. 3. For disputed matches, the admin can use `emergency_drain()` (requires pause) to move funds to a safe address pending dispute resolution off-chain. 4. Unpause once the new oracle is operational. |

### Admin Key Loss

| Attribute | Assessment |
|-----------|------------|
| **Impact** | **High**. A lost admin key permanently prevents `pause()`, `unpause()`, `update_oracle()`, and `emergency_drain()`. If the oracle key is also compromised, there is no way to stop the contract. If the oracle is functioning, the contract continues to operate normally. |
| **Likelihood** | **Low**. Admin key should be stored securely (hardware wallet, multi-sig, cold storage). |
| **Mitigations** | |
| | 1. **Multi-sig**: The admin address SHOULD be a multi-sig contract (e.g., Stellar clawback or Soroban multi-sig) requiring M-of-N signatures. |
| | 2. **Backup keys**: At minimum, a backup admin key should be held by a separate trusted party. |
| | 3. **Timelock**: A future enhancement should add a timelock between `pause()` and `emergency_drain()`, giving players time to react. |
| | 4. **Safe address binding**: Even if the admin key is compromised (rather than lost), `emergency_drain` can only transfer to the `safe_address` fixed at `initialize` time — the attacker cannot redirect funds to an arbitrary address. |
| **Recovery** | | |
| | 1. If the contract has been initialized with a multi-sig admin, the admin role can be recovered through the multi-sig's governance process. |
| | 2. **No on-chain recovery exists for a single-key admin**. The contract would need to be re-deployed and all active matches migrated off-chain. |
| | 3. **Future enhancement**: A social recovery mechanism (e.g., N-of-M guardian accounts) could restore admin privileges. |

### Lichess / Chess.com API Manipulation

| Attribute | Assessment |
|-----------|------------|
| **Impact** | **High**. If the chess platform returns fraudulent results (or the oracle does not verify API responses correctly), incorrect payouts are executed. The contract trusts the oracle to verify API responses. |
| **Likelihood** | **Low**. Both Lichess and Chess.com have established reputations; API responses are signed or served over TLS. The oracle should additionally verify the response against a secondary source or require cryptographic proof. |
| **Mitigations** | |
| | 1. **Oracle verification**: The oracle service must independently verify the API response (e.g., check multiple endpoints, validate TLS certificates, cross-reference game state). |
| | 2. **Game ID binding**: The `game_id` stored in the match record must match the `game_id` submitted by the oracle. This prevents the oracle from reusing a legitimate result from one match in another. |
| | 3. **Event monitoring**: All result submissions emit events; anomalous results can be detected off-chain. |
| | 4. **Dispute window**: A future enhancement should add a challenge period during which players can dispute a result with proof. |
| **Recovery** | 1. Admin pauses the contract. 2. Admin investigates the fraudulent submissions off-chain. 3. If funds remain in the contract, `emergency_drain()` can recover them. 4. For funds already paid out, legal recourse or social consensus is required. |

### Front-Running Attacks

| Threat | Description | Risk | Mitigation |
|--------|-------------|------|------------|
| **Deposit front-running** | An attacker observes a `create_match` transaction and submits a `deposit` before the intended player. | Low | `deposit` checks that the caller is `player1` or `player2` from the match record. The attacker's address would not match either player. |
| **Cancel front-running** | An attacker observes a `deposit` and front-runs with `cancel_match` to lock the deposit. | Low | `cancel_match` also requires the caller to be a player. Additionally, once both players have deposited (state = Active), `cancel_match` is rejected. |
| **Oracle result front-running** | An attacker observes a pending oracle submission and submits their own result first. | Low | Only the registered oracle address can submit results. The attacker cannot spoof the oracle identity. |

---

## Threat Model & Mitigations (per-function)

### emergency_drain Rug-Pull (issue #1102)

**Threat**: The original `emergency_drain(to: Address, caller: Address)` accepted an arbitrary destination address. A compromised or malicious admin could pause the contract and call `emergency_drain` with an attacker-controlled address as `to`, transferring the entire token balance — including all live player stakes — to that address. This is a classic rug-pull vector: a single compromised key grants unconditional custody over all escrowed funds.

**Risk rating**: **Critical**. The admin key is the sole gating condition. There is no time-lock, no second signer requirement, and no on-chain recourse once the transfer executes.

**Mitigation (applied — issue #1102)**:

The `to` parameter has been removed from `emergency_drain`. A `safe_address: Address` parameter is now required in `initialize()` and stored immutably under `DataKey::SafeAddress`. `emergency_drain` reads that stored address and always drains to it — the call site cannot supply a different destination.

```
initialize(oracle, admin, token, safe_address)  ← safe_address set once, never changed
emergency_drain(caller)                         ← destination is always DataKey::SafeAddress
```

**Residual risk**: The admin can still trigger a drain to `safe_address` at will (subject to the `is_paused` guard). If `safe_address` was set to an attacker-controlled address at deployment time, the protection is void. Operators MUST verify `safe_address` in the deployment transaction before any player funds are deposited. A future enhancement should add a timelock between `pause()` and `emergency_drain()` so players have a window to react.

**What this does not protect against**:
- A malicious deployer who sets `safe_address` to their own address at initialization time. Deployment-time parameters must be audited.
- Admin key compromise used to pause the contract indefinitely (freezing player funds). This is mitigated separately by advising multi-sig admin keys.

### Re-initialization Attack

**Threat**: An attacker calls `initialize` a second time to overwrite the oracle or admin address.

**Mitigation**: Both contracts check `env.storage().instance().has(&DataKey::Oracle/Admin)` before writing. A second call panics immediately.

### Malicious Oracle Substitution

**Threat**: An attacker replaces the oracle address to redirect payouts.

**Mitigation**: The oracle address is set at initialization and can only be rotated by the admin via `update_oracle`. The admin key is separate from the oracle key.

### Unauthorized Result Submission

**Threat**: A non-oracle address calls `submit_result` on the escrow contract.

**Mitigation**: `submit_result` compares `caller` against the stored `DataKey::Oracle` address and returns `Error::Unauthorized` on mismatch, before any state change.

### Double Result Submission

**Threat**: The oracle submits a result twice, potentially changing the winner.

**Mitigation**: The escrow contract checks `m.state == Active` before processing. Once set to `Completed`, any further `submit_result` call returns `Error::InvalidState`. The oracle contract additionally rejects duplicate submissions with `Error::AlreadySubmitted`.

### Cross-Match Result Injection (GameIdMismatch)

**Threat**: A compromised oracle submits a result for the correct `match_id` but with a `game_id` belonging to a different game, redirecting a payout to the wrong winner.

**Mitigation**: `submit_result` on the escrow contract requires a `game_id` parameter and compares it against the `game_id` stored in the match record at creation time. A mismatch returns `Error::GameIdMismatch` before any state change or token transfer occurs.

### Duplicate Game ID Exploit (DuplicateGameId)

**Threat**: An attacker creates multiple matches referencing the same chess `game_id`. If the oracle submits a result for that game, all duplicate matches could be paid out, draining the contract.

**Mitigation**: `create_match` tracks every accepted `game_id` in persistent storage under `DataKey::GameId(game_id)`. A second `create_match` call with the same `game_id` returns `Error::DuplicateGameId` immediately, before any match record is written.

### Deposit into Inactive Match

**Threat**: A player deposits into a cancelled or completed match, locking funds.

**Mitigation**: `deposit` checks `m.state == Pending` and returns `Error::InvalidState` for any other state.

### Zero-Stake Match

**Threat**: A match is created with `stake_amount = 0`, wasting ledger storage.

**Mitigation**: `create_match` returns `Error::InvalidAmount` if `stake_amount <= 0`.

### Self-Match

**Threat**: A single address creates a match against itself to manipulate state or waste resources.

**Mitigation**: `create_match` checks `player1 != player2` and returns `Error::InvalidPlayers` on violation.

### Contract Addresses as Players (Re-entrancy via Malicious Player Contract)

**Threat**: A player registers the address of a *malicious smart contract* as `player1` or `player2` with the intent of re-entering the escrow during token transfers (Solidity/EVM-style re-entrancy) or of mounting some other cross-contract confused-deputy attack on the escrow.

**Is this a real risk under Soroban? — No.**

Soroban's execution model structurally prevents the two classic contract-player attacks that apply to EVM chains:

1. **No synchronous re-entrancy / callbacks.** When the escrow calls `token::transfer` → `player`, the runtime does **not** yield execution back to a contract player. Token SAC contracts (`soroban_sdk::token`) perform a pure host-side ledger balance update; they invoke no user-supplied code. Even if player was backed by a wasm contract with a custom `receive`/`fallback` (which Soroban does **not** have for SAC tokens — the SAC is a host primitive), Soroban enforces that an already-executing contract cannot be re-entered within the same host frame: any nested invocation is simply a new, isolated frame that cannot mutate the escrow's state mid-flight.

2. **No confused-deputy token approvals.** The escrow transfers tokens *from itself* to `player1`/`player2` at payout time. It never holds a `transferFrom` allowance granted by `player` that a player-contract could trick it into spending on some 3rd party (the direction is always `contract → player`, never `player → contract` on the payout path, and the inbound `deposit` path is `player → contract` with the player's own explicit `token.approve`).

The concrete mitigations that apply regardless are:

- **`player.require_auth()` is enforced** for every player-gated function (`create_match`, `deposit`, `cancel_match`, `claim_timeout`). For a contract address, `require_auth` is satisfied *only* by the contract submitting a Soroban-level auth entry — i.e. the contract itself (its wasm code) must willingly authorise the call. There is no way for a passive player-contract to be "tricked" into having someone else spend its allowance on its behalf.
- **State transitions are guarded by `MatchState`.** Once a payout has been validated and the match moves to `Completed`/`Cancelled`, no further state change is possible regardless of what a player-address is.
- **Escrow never invokes the player address directly.** All cross-contract calls go to the SAC token, never to `player1` / `player2`.

**Documentation verdict**: Accepted as explicitly non-risk under the Soroban execution model. No on-chain guard restricting players to classic `G…` Stellar addresses is warranted, because such a restriction would merely disable legitimate use-cases (e.g. a multi-sig vault contract being used as the player's address) without adding any security benefit in a protocol where re-entrancy is structurally impossible. See `test_contract_address_as_player_completes_full_lifecycle` in `contracts/escrow/src/tests.rs`, which exercises create → deposit × 2 → result submission with registered contract addresses as both players to confirm the behaviour end-to-end.

### Storage Expiry

**Threat**: A persistent `Match` entry expires mid-game, causing `MatchNotFound` errors.

**Mitigation**: Every persistent write calls `extend_ttl` with `MATCH_TTL_LEDGERS` (518,400 ledgers, ~30 days). TTL is refreshed on deposit, result submission, and cancellation.

### Contract Vulnerability Response

**Threat**: A critical bug is discovered post-deployment with no way to stop ongoing damage.

**Mitigation**: The admin can call `pause()` to block `create_match`, `deposit`, and `submit_result`. Existing matches can still be cancelled to recover funds. `unpause()` restores normal operation.

### Integer Overflow in Match Counter

**Threat**: `MatchCount` wraps silently in release mode, reusing match IDs.

**Mitigation**: `create_match` uses `id.checked_add(1).ok_or(Error::Overflow)?`.

### Insufficient Token Allowance

**Threat**: `deposit` is called without the player first approving sufficient token allowance for the escrow contract, resulting in a generic transfer failure.

**Mitigation**: Before calling `try_transfer`, `deposit` checks `token.allowance(player, env.current_contract_address()) >= stake_amount` and returns `Error::InsufficientAllowance` with a clear message if not met. See `contracts/escrow/src/lib.rs`.

### Re-entrancy

**Threat**: A malicious token contract could re-enter the escrow contract during the `try_transfer` or `transfer` call, modifying state in unexpected ways.

**Mitigation**: Soroban's execution model prevents re-entrancy — the runtime does not allow a contract to be re-entered while it is already executing. All state changes in `deposit` occur after the external call (checks-effects-interactions pattern is followed for token transfers). See `// SAFETY: no re-entrancy risk because...` comments in `contracts/escrow/src/lib.rs` and the re-entrancy tests in `contracts/escrow/src/tests.rs`.

### Out-of-Range Match ID

**Threat**: Functions accepting a `match_id` may receive an out-of-range value (e.g., `u64::MAX`), causing a storage read miss that returns `MatchNotFound` rather than a more descriptive error.

**Mitigation**: All functions accepting `match_id` validate `match_id < get_match_count()` up front and return `Error::MatchNotFound` for invalid IDs, providing a consistent and predictable error path. See `contracts/escrow/src/lib.rs`.

---

## Access Control Summary

| Function | Who can call |
|----------|-------------|
| `initialize` | Anyone (once only) |
| `create_match` | `player1` (requires auth) |
| `deposit` | `player1` or `player2` (requires auth) |
| `cancel_match` | `player1` or `player2` (requires auth) |
| `submit_result` | Registered oracle address only |
| `pause` / `unpause` | Admin only |
| `emergency_drain` | Admin only (contract must be paused; funds always sent to pre-registered `safe_address`) |
| `update_oracle` | Admin only |
| `get_match` / `is_funded` / `get_escrow_balance` | Anyone (read-only) |

---

## Re-entrancy Analysis

### Soroban's Single-Execution Model

Soroban (Stellar's smart-contract platform) executes each contract invocation atomically within a single host frame. Unlike EVM, Soroban does **not** allow a called contract to invoke the caller back during the same transaction. The host enforces a strict call-stack depth limit and does not yield control mid-execution, making traditional re-entrancy attacks structurally impossible.

### Cross-Contract Call Patterns in This Codebase

| Contract | Function | Cross-contract call | Re-entrancy possible? |
|----------|----------|--------------------|-----------------------|
| Escrow | `deposit` | `token::try_transfer` (player → contract) | No — token cannot call back into escrow |
| Escrow | `submit_result` | `token::transfer` (contract → winner) | No — payout is the last action; state is written before the call |
| Escrow | `cancel_match` / `emergency_drain` | `token::transfer` (contract → player) | No — same reason as above |
| Oracle | `withdraw` | `token::try_transfer` (contract → recipient) | No — Soroban's model prevents callbacks |

### Checks-Effects-Interactions

Both contracts follow the checks-effects-interactions pattern as an additional layer of defence:

- State is validated and updated **before** any `token::transfer` or `token::try_transfer` call.
- Inline `// SAFETY:` comments in `submit_result` (oracle) and `withdraw` (oracle) document this reasoning at the call site.

### Conclusion

No re-entrancy vectors exist in this codebase. The Soroban execution model provides structural prevention, and the code additionally follows checks-effects-interactions ordering. Player addresses may be contract addresses (e.g. multi-sig vaults) without introducing any new re-entrancy or confused-deputy risk; see "Contract Addresses as Players" in the per-function mitigations section above.

---

## Known Limitations

- The oracle service is a centralised component. A compromised oracle key can submit incorrect results. Key rotation via `update_oracle` mitigates this without redeployment.
- There is no timeout mechanism to auto-cancel a match if the oracle never submits a result. Players must manually cancel a pending match to recover funds. For matches in `Active` state (both players deposited), no on-chain cancellation is possible — the oracle must submit a result.
- The admin `pause` function does not block `cancel_match`, so players can always recover deposits even when the contract is paused.
- There is no on-chain recovery for a lost single-key admin. Multi-sig admin is strongly recommended for production deployments.
- There is no challenge/dispute period for oracle-submitted results. Players must trust the oracle's correctness off-chain.

## Future Security Enhancements

- **Multi-sig oracle**: Require M-of-N oracle signatures to submit a result, preventing single-key compromise from authorizing fraudulent payouts.
- **Timelocked emergency drain**: Add a delay between `pause()` and `emergency_drain()` so players can monitor and react before funds are moved. (The destination is already fixed to `safe_address` — this enhancement would add a reaction window on top of that.)
- **Result dispute window**: Allow players to challenge a result within a defined window by providing cryptographic proof.
- **Admin social recovery**: N-of-M guardian accounts could restore admin access in case of key loss.
- **Auto-cancel timeout**: Automatically cancel matches that remain in `Active` beyond a reasonable ledger count.
- ~~**Restrict emergency_drain destination to a safe address**~~: **Done (issue #1102).** `emergency_drain` no longer accepts a `to` parameter. The destination is fixed at `initialize` time via `safe_address`.

## Threat Model Review Log

| Date | Reviewer | Sign-off |
|------|----------|----------|
| 2026-06-24 | Internal review | ✅ Approved — STRIDE analysis complete, all identified threats have documented mitigations or accepted risk. |
| 2026-07-25 | Issue #1102 remediation | ✅ `emergency_drain` rug-pull vector resolved. Removed arbitrary `to` parameter; drain destination now fixed to `safe_address` at `initialize` time. STRIDE Tampering table, per-function analysis, Trust Assumptions, and Access Control Summary updated to reflect the change. |

## Secrets Management

### ORACLE_SECRET_KEY

The oracle service signs Stellar transactions using a private key loaded exclusively from the `ORACLE_SECRET_KEY` environment variable. This key must **never** be hardcoded in source code or committed to the repository.

| Variable | Description | Required |
|----------|-------------|----------|
| `ORACLE_SECRET_KEY` | Stellar secret key (S…) used by the oracle to sign result submissions | Yes |
| `LICHESS_API_TOKEN` | Lichess API token for fetching game results | Yes |
| `CHESSDOTCOM_API_KEY` | Chess.com API key for fetching game results | Yes |

The oracle service validates all required environment variables at startup and exits with a fatal log message if any are missing.

**Production guidance**: Store `ORACLE_SECRET_KEY` in a secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault) and inject it at runtime. Rotate the key via `update_oracle` on the escrow contract after rotation.

## Wagering Eligibility Policy

**Status:** Adopted by engineering. **Legal review: pending.** Mainnet wagering must not launch
until the review record below is completed (issue #113).

smile4money lets people stake real funds on the outcome of chess games. Who may do that, and where,
is a legal question the code can't answer on its own. This section states the policy, and
[deployment.md → Eligibility Enforcement](deployment.md#eligibility-enforcement) assigns who
enforces each part of it.

### Policy

1. **Minimum age: 18**, or the higher age a supported jurisdiction requires (for example 21). Nobody
   under that age may wager. A deployment may raise the age (`VITE_MIN_WAGERING_AGE`) but never
   lower it below 18; the frontend ignores lower values.
2. **Jurisdictions: default deny.** Real-money wagering is offered only in jurisdictions listed,
   after legal review, in the deployment's supported list (`VITE_SUPPORTED_JURISDICTIONS`).
   Everywhere else is unsupported, including places where the law is unclear. An empty list means
   *no* jurisdiction is supported for real-money play.
3. **No claim of universal availability.** No user-facing copy may say or suggest that the service
   is legal or available to everyone or everywhere. The frontend shows an eligibility notice
   wherever money moves (the home page, match creation and stake deposit). It names the age limit
   and the supported jurisdictions, or says that none are published. A test fails the build if
   wording such as "available worldwide" appears in the app.
4. **Testnet is not wagering.** Test networks use tokens with no value, and the notice says so. The
   policy applies to real funds, on mainnet.
5. **The contracts can't enforce eligibility.** Soroban contracts can't see a user's age or
   location, and wallet addresses are pseudonymous. Enforcement therefore sits with the operator,
   at the edges the operator controls (see the deployment responsibilities). It never relies on the
   contract.
6. **Self-attestation is not verification.** Wherever a supported jurisdiction's law requires
   identity or age verification (KYC), the operator must use a verification provider before
   allowing deposits. A "tick to confirm you are 18" box doesn't meet that requirement.

### Review record

| Item | Owner | Status |
|---|---|---|
| Minimum age per supported jurisdiction confirmed | Legal counsel | Pending |
| Supported jurisdiction list approved, and the reasoning for each excluded one recorded | Legal counsel + operator | Pending |
| KYC / age-verification requirement decided per jurisdiction | Legal counsel + operator | Pending |
| User-facing eligibility terms published (`VITE_ELIGIBILITY_TERMS_URL`) | Operator | Pending |
| Policy re-reviewed (at least yearly, and before adding a jurisdiction) | Legal counsel | Pending |

Update a row with a date, the reviewer and a link to the evidence when it is done. The review is
complete only when every row is done. Until then the deployment must keep
`VITE_SUPPORTED_JURISDICTIONS` empty, and the UI then tells users not to wager real funds.

## Reporting Vulnerabilities

Open a GitHub issue with the label `security`. For critical vulnerabilities, contact the maintainers directly before public disclosure.
