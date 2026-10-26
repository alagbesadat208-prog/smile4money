# emergency_drain() Active Match Fix - Design Document

## Overview

This design document formalizes the security fix for Issue #8: preventing `emergency_drain()` from being callable while a match is in the `Active` state. 

The bug poses a critical security and data integrity risk. If `emergency_drain` were callable during active matches, an admin could drain the contract's entire token balance while player stakes are locked in escrow for ongoing games. This would result in stealing player funds, as the contract would no longer have sufficient balance to pay out match results or refund cancelled matches.

The fix adds a guard that iterates through all matches and returns `Err(Error::ActiveMatchExists)` if any match is in the `Active` state, rejecting the drain operation before any funds are transferred.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — calling `emergency_drain()` when at least one match is in the `Active` state (both players have deposited and the game is in progress)
- **Property (P)**: The desired behavior — `emergency_drain()` should reject with `Err(Error::ActiveMatchExists)` when any match is `Active`
- **Preservation**: Existing behavior — `emergency_drain()` should continue to drain successfully when no matches are `Active`, and existing guards (pause check, authorization check) should remain unchanged
- **MatchState**: An enum representing the lifecycle state of a chess match: `Pending`, `Active`, `PendingResult`, `Completed`, or `Cancelled`
- **Active State**: Both players have deposited their stakes and the game is in progress; funds are held in escrow by the contract
- **Terminal States**: `Completed` (payout finalized) and `Cancelled` (match cancelled or timed out); no further transitions possible
- **emergency_drain()**: A privileged admin-only function that transfers the entire contract token balance to a pre-registered `safe_address` when the contract is paused
- **Error::ActiveMatchExists**: New error variant (code 33) returned when `emergency_drain()` detects at least one `Active` match

## Bug Details

### Bug Condition

The bug manifests when an admin calls `emergency_drain()` while at least one match is in the `Active` state (both players have deposited and the game is in progress). The function previously executed successfully without checking for active matches, silently allowing the drain to proceed and stealing player funds.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type (caller: Address, contract_state: ContractState)
  OUTPUT: boolean
  
  LET match_list = getAllMatches(contract_state)
  LET has_active = EXISTS match IN match_list WHERE match.state == Active
  
  RETURN caller == admin
         AND caller has authorization
         AND contract_is_paused == true
         AND has_active == true
         AND emergency_drain_is_called == true
END FUNCTION
```

### Examples

- **Buggy Example 1**: Admin pauses contract with Match 1 in `Active` state (both players deposited). Admin calls `emergency_drain()`. Result: Funds drained, player stakes stolen. Expected: Rejection with `ActiveMatchExists` error.

- **Buggy Example 2**: Admin pauses contract with 3 matches: Match 0 (`Completed`), Match 1 (`Active`), Match 2 (`Cancelled`). Admin calls `emergency_drain()`. Result: Funds drained despite Match 1 being active. Expected: Rejection without draining.

- **Buggy Example 3**: Admin pauses contract with Match 0 in `Active` state. Admin calls `emergency_drain()` within the same transaction. Result: No validation of match state; drain proceeds. Expected: Guard checks all matches for `Active` state.

- **Safe Example (Non-Bug)**: Admin pauses contract with Match 0 (`Completed`), Match 1 (`Cancelled`). Admin calls `emergency_drain()`. Result: Funds drained successfully. Expected: No error, drain succeeds.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- When no matches exist in `Active` state and the contract is paused, `emergency_drain()` must continue to execute successfully and drain the entire contract token balance to the pre-registered `safe_address`
- When all existing matches are in terminal states (`Completed` or `Cancelled`) and the contract is paused, `emergency_drain()` must continue to proceed normally without rejecting the drain operation
- Existing authorization guard: non-admin addresses must continue to be rejected with `Err(Error::Unauthorized)`
- Existing pause guard: calling `emergency_drain()` without pausing the contract first must continue to return `Err(Error::NotPaused)`
- When a match transitions from `Active` to `Completed` or `Cancelled`, `emergency_drain()` must continue to allow subsequent drain calls without any restriction

**Scope:**
All inputs that do NOT involve calling `emergency_drain()` while active matches exist should be completely unaffected by this fix. This includes:
- Calling `emergency_drain()` on a paused contract with no `Active` matches (should drain successfully)
- Calling `emergency_drain()` without pausing the contract first (should fail with `NotPaused`)
- Calling `emergency_drain()` with a non-admin address (should fail with `Unauthorized`)
- All other contract operations (`create_match`, `deposit`, `submit_result`, `claim_timeout`, `finalize_result`, `cancel_match`, etc.) must be unaffected

## Hypothesized Root Cause

Based on the bug description, the root causes are:

1. **Missing Active Match Check**: The `emergency_drain()` function did not validate the state of any active matches before proceeding with the drain operation. The function only checked for admin authorization and contract pause status, but had no guard against draining while funds were locked in active matches.

2. **Implicit Trust in Admin**: The original design trusted the admin to manually ensure no active matches existed before calling `emergency_drain()`. This is a design flaw because:
   - A malicious admin could deliberately drain funds while matches are active to steal player stakes
   - An honest admin could accidentally drain while active matches exist due to race conditions or oversight
   - There was no enforcement mechanism to prevent this scenario

3. **No Audit Trail for Prevention**: Without this guard, there is no way to distinguish between:
   - An intentional rug-pull (malicious admin draining while matches are active)
   - An accidental drain (admin unaware of active matches)

4. **Missing Invariant**: The contract should enforce the invariant: "emergency_drain can only succeed if no funds are locked in active matches"

## Correctness Properties

Property 1: Bug Condition - Reject Drain When Active Matches Exist

_For any_ call to `emergency_drain()` where at least one match exists in the `Active` state, the fixed function SHALL return `Err(Error::ActiveMatchExists)` without draining any funds, before any token transfer is executed.

**Validates: Requirements 2.1, 2.2**

Property 2: Preservation - Drain Succeeds Without Active Matches

_For any_ call to `emergency_drain()` where no matches exist in the `Active` state (all matches are in terminal states or no matches exist), the fixed function SHALL produce the same result as a hypothetically unfixed function: successfully transfer the entire contract balance to `safe_address` and return `Ok(())`.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct, the fix is already implemented in the escrow contract at `contracts/escrow/src/lib.rs` in the `emergency_drain()` function:

**File**: `contracts/escrow/src/lib.rs`

**Function**: `emergency_drain()` (line ~1150)

**Specific Changes**:

1. **Active Match Guard Added**: Before executing any fund transfer, the function now iterates through all matches stored in the contract and checks if any are in the `Active` state. This is the new safety guard.

   ```rust
   // Safety guard: block the drain when any match is currently `Active`
   let match_count = Self::get_match_count(&env);
   let mut i: u64 = 0;
   while i < match_count {
       if let Some(m) = env
           .storage()
           .persistent()
           .get::<DataKey, Match>(&DataKey::Match(i))
       {
           if m.state == MatchState::Active {
               return Err(Error::ActiveMatchExists);
           }
       }
       i += 1;
   }
   ```

2. **New Error Variant**: The `Error::ActiveMatchExists` variant (code 33) was added to `contracts/escrow/src/errors.rs` to represent this specific error condition.

3. **Iteration Logic**: The guard iterates from match index 0 to `match_count - 1`, fetching each match from persistent storage and checking its state. If any match is `Active`, the function returns early with the error.

4. **Early Return**: The check is performed BEFORE the actual fund transfer (before `client.transfer(&contract, &safe_address, &balance)`), ensuring atomicity — either the guard rejects completely, or the drain proceeds to completion.

5. **Placement**: The guard is placed after the authorization and pause checks but before the fund transfer, following the principle of "fail fast" for validation.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on the unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that simulate `emergency_drain()` calls when one or more matches are in the `Active` state. Run these tests on the UNFIXED code to observe failures (drain succeeding when it should fail) and understand the root cause.

**Test Cases**:

1. **Single Active Match Test**: Create one match, have both players deposit (transition to `Active`), pause the contract, and call `emergency_drain()`. On unfixed code, the drain will succeed (bug). On fixed code, should return `Err(Error::ActiveMatchExists)`.

2. **Multiple Matches with One Active**: Create 3 matches with states: Match 0 (`Completed`), Match 1 (`Active`), Match 2 (`Cancelled`). Pause contract and call `emergency_drain()`. On unfixed code, drain succeeds. On fixed code, should return error because Match 1 is `Active`.

3. **Multiple Active Matches**: Create 2 matches both in `Active` state. Pause contract and call `emergency_drain()`. On unfixed code, drain succeeds. On fixed code, should reject immediately upon finding first `Active` match.

4. **Just Before Activation**: Create a match where only Player 1 has deposited (still `Pending`). Pause contract and call `emergency_drain()`. Should succeed because no matches are `Active`.

**Expected Counterexamples**:
- `emergency_drain()` returns `Ok(())` and drains funds when at least one match is `Active` (demonstrates the bug)
- No validation of match states before fund transfer (demonstrates root cause)

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds (active matches exist), the fixed function produces the expected behavior (rejection with `ActiveMatchExists`).

**Pseudocode:**
```
FOR ALL inputs WHERE isBugCondition(input) DO
  result := emergency_drain_fixed(input)
  ASSERT result == Err(Error::ActiveMatchExists)
  ASSERT no_funds_were_transferred(input)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold (no active matches), the fixed function produces the same result as the original function (drain succeeds).

**Pseudocode:**
```
FOR ALL inputs WHERE NOT isBugCondition(input) DO
  result_original := emergency_drain_original(input)
  result_fixed := emergency_drain_fixed(input)
  ASSERT result_original == result_fixed
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (different numbers of matches, different combinations of terminal states)
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: 

First observe behavior on UNFIXED code for drain operations with non-active matches. Then write property-based tests capturing that behavior and verify it continues to hold after the fix.

**Test Cases**:

1. **No Matches Preservation**: Contract with zero matches. Pause and call `emergency_drain()`. Should drain successfully and return `Ok(())` on both unfixed and fixed code.

2. **All Terminal Matches Preservation**: Contract with multiple matches all in `Completed` or `Cancelled` states. Pause and call `emergency_drain()`. Should drain successfully on both versions.

3. **Only Completed Matches**: Generate random numbers of completed matches, pause, and call `emergency_drain()`. Should always succeed and transfer balance.

4. **Only Cancelled Matches**: Generate random numbers of cancelled matches, pause, and call `emergency_drain()`. Should always succeed and transfer balance.

5. **Mixed Terminal States**: Generate random mixes of `Completed` and `Cancelled` matches. Should always drain successfully.

6. **Authorization Check Preservation**: Non-admin address calls `emergency_drain()`. Should always return `Err(Error::Unauthorized)` regardless of match states.

7. **Pause Check Preservation**: Admin calls `emergency_drain()` on unpaused contract. Should always return `Err(Error::NotPaused)` regardless of match states.

### Unit Tests

- Test that `emergency_drain()` returns `ActiveMatchExists` when exactly one match is `Active`
- Test that `emergency_drain()` returns `ActiveMatchExists` when multiple matches are `Active`
- Test that `emergency_drain()` succeeds when no matches exist
- Test that `emergency_drain()` succeeds when all matches are in terminal states
- Test that existing authorization guard still works (non-admin is rejected)
- Test that existing pause guard still works (contract must be paused)
- Test that the guard checks all matches (not just the first one)

### Property-Based Tests

- Generate random game states with varying numbers of matches in different states; verify `emergency_drain()` only succeeds when no matches are `Active`
- Generate random sequences of match state transitions and `emergency_drain()` calls; verify consistency with the safety invariant
- Generate random match creation/deposit patterns; verify the guard correctly identifies `Active` matches
- For all non-buggy inputs (no `Active` matches), verify output behavior is identical to unfixed code

### Integration Tests

- Full game flow: create multiple matches, deposit for some, bring one to `Active`, attempt `emergency_drain()` (should fail), complete the active match, attempt `emergency_drain()` again (should succeed)
- Concurrent scenario: admin initiates pause while matches are transitioning states, then attempts drain; verify atomicity of guard
- Recovery scenario: drain fails with `ActiveMatchExists`, later all active matches reach terminal states, retry drain successfully
- Verify event emissions remain consistent with non-buggy paths (drain event still emitted when drain succeeds, no event when guard rejects)
