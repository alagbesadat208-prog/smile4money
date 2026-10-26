# Implementation Plan: emergency_drain() Active Match Fix

## Phase 3: Implementation Tasks

### Overview

This task list follows the exploratory bugfix workflow:
1. **Explore** - Write tests BEFORE fix to understand the bug (Bug Condition)
2. **Preserve** - Write tests for non-buggy behavior (Preservation Requirements)
3. **Implement** - Apply the fix with understanding (Expected Behavior)
4. **Validate** - Verify fix works and doesn't break anything

---

## Task 1: Bug Condition Exploration Test

- [ ] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Reject Drain When Active Matches Exist
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: For deterministic bugs, scope the property to concrete failing case(s) to ensure reproducibility
  
  **Test Implementation Details** (from Bug Condition in design):
  - Test Call Sequence:
    1. Create a new match with Player A and Player B
    2. Have Player A deposit their stake (match transitions toward `Active`)
    3. Have Player B deposit their stake (match transitions to `Active` state)
    4. Pause the contract (set `is_paused = true`)
    5. Call `emergency_drain()` as the admin
  
  - Test Assertion (from Expected Behavior in design):
    - On unfixed code: `emergency_drain()` returns `Ok(())` and drains funds (BUG)
    - On fixed code: `emergency_drain()` returns `Err(Error::ActiveMatchExists)` and funds are NOT transferred
  
  - Test Scenarios:
    1. **Single Active Match**: One match in `Active` state, drain should fail with `ActiveMatchExists`
    2. **Multiple Matches with One Active**: Mix of matches (Match 0: `Completed`, Match 1: `Active`, Match 2: `Cancelled`), drain should fail
    3. **Multiple Active Matches**: Two matches both in `Active` state, drain should fail on first discovery
    4. **Boundary: Just Before Active**: Match with only Player 1 deposited (still `Pending`), drain should succeed (control case)
  
  - Test Assertions Should Match Expected Behavior Properties:
    - `emergency_drain()` returns `Err(Error::ActiveMatchExists)` for all inputs with active matches
    - No token transfer occurs when active matches exist
    - Error is returned BEFORE any funds are transferred (atomicity)
  
  - **Run test on UNFIXED code**
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found to understand root cause:
    - Example: "When match ID 1 is in Active state and emergency_drain() is called, it returns Ok(()) instead of Err(ActiveMatchExists), draining all funds despite locked player stakes"
  
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 2.1, 2.2_

---

## Task 2: Preservation Property Tests

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Drain Succeeds Without Active Matches
  - **IMPORTANT**: Follow observation-first methodology
  - **CRITICAL**: These tests MUST PASS on unfixed code - they capture baseline behavior to preserve
  
  **Observation Phase** (on unfixed code):
  - Observe: Call `emergency_drain()` with zero matches → returns `Ok(())`, balance transferred to `safe_address`
  - Observe: Call `emergency_drain()` with all matches in `Completed` state → returns `Ok(())`, balance transferred
  - Observe: Call `emergency_drain()` with all matches in `Cancelled` state → returns `Ok(())`, balance transferred
  - Observe: Call `emergency_drain()` with no admin authorization → returns `Err(Error::Unauthorized)`
  - Observe: Call `emergency_drain()` without pausing → returns `Err(Error::NotPaused)`
  
  **Test Implementation Details** (from Preservation Requirements in design):
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements
  - Property-based testing generates many test cases for stronger guarantees
  - Test Scenarios:
    1. **No Matches Preservation**: Generate contracts with zero matches, pause, call drain → should succeed and transfer all balance
    2. **All Terminal Matches Preservation**: Generate N completed matches (N=1..20), pause, call drain → should succeed for all N
    3. **All Cancelled Matches Preservation**: Generate N cancelled matches (N=1..20), pause, call drain → should succeed for all N
    4. **Mixed Terminal States Preservation**: Generate random mixes of M completed and N cancelled matches, pause, call drain → should always succeed
    5. **Authorization Check Preservation**: Non-admin tries to drain any contract state → should always return `Unauthorized`
    6. **Pause Check Preservation**: Admin tries to drain on unpaused contract with any match states → should always return `NotPaused`
    7. **Balance Transfer Verification**: After successful drain, contract balance should be zero and safe_address balance should be increased
  
  - **Run tests on UNFIXED code**
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  
  - Property Assertions:
    - For all non-buggy inputs (no Active matches), `emergency_drain()` returns `Ok(())`
    - For all non-buggy inputs, entire contract balance is transferred to `safe_address`
    - For all inputs, authorization check works (non-admin is rejected)
    - For all inputs, pause check works (unpaused contract is rejected)
    - Match state transitions don't affect drain behavior after reaching terminal states
  
  - Mark task complete when tests are written, run, and PASSING on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

---

## Task 3: Fix Implementation

- [ ] 3. Fix for emergency_drain() active match rejection

  - [ ] 3.1 Implement the active match guard
    - **Location**: `contracts/escrow/src/lib.rs`, function `emergency_drain()` (line ~1150)
    - **Implementation Details**:
      1. Add active match check AFTER authorization and pause checks, BEFORE fund transfer
      2. Iterate through all matches stored in contract persistent storage
      3. For each match, retrieve the match state from persistent storage
      4. If any match has state `MatchState::Active`, return `Err(Error::ActiveMatchExists)` immediately
      5. If no active matches are found, proceed with existing drain logic (transfer funds to `safe_address`)
    
    - **Code Pattern**:
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
    
    - **Guard Placement**: After authorization check and pause check, before `client.transfer()`
    - **Atomicity**: Guard must execute BEFORE any fund transfer to ensure atomicity
    - **Error Handling**: New `Error::ActiveMatchExists` variant should already exist in `contracts/escrow/src/errors.rs` with code 33
    
    - _Bug_Condition: isBugCondition(input) where match.state == Active AND emergency_drain_is_called == true_
    - _Expected_Behavior: expectedBehavior(result) = Err(Error::ActiveMatchExists) BEFORE fund transfer_
    - _Preservation: All non-buggy paths (no Active matches) should drain successfully as before_
    - _Requirements: 2.1, 2.2_

  - [ ] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Reject Drain When Active Matches Exist
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - **Run bug condition exploration test from step 1**
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - **Verification Checklist**:
      - Single active match case: drain rejects with `ActiveMatchExists`
      - Multiple matches with one active case: drain rejects with `ActiveMatchExists`
      - Multiple active matches case: drain rejects with `ActiveMatchExists`
      - Control case (just before active): drain succeeds (no regression)
    - All test assertions from task 1 should now pass
    - _Requirements: Expected Behavior Properties from design (2.1, 2.2)_

  - [ ] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Drain Succeeds Without Active Matches
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - **Run preservation property tests from step 2**
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - **Verification Checklist**:
      - No matches preservation: drain succeeds
      - All completed matches preservation: drain succeeds
      - All cancelled matches preservation: drain succeeds
      - Mixed terminal states preservation: drain succeeds
      - Authorization check preservation: non-admin still rejected
      - Pause check preservation: unpaused contract still rejected
      - Balance transfer verification: funds correctly transferred in all success cases
    - Confirm all tests from task 2 still pass after fix (no regressions)
    - _Requirements: Preservation Requirements from design (3.1, 3.2, 3.3, 3.4, 3.5, 3.6)_

---

## Task 4: Checkpoint - Ensure All Tests Pass

- [ ] 4. Checkpoint - Ensure all tests pass
  - Run complete test suite for the emergency_drain fix:
    - Execute bug condition exploration test from task 1 → should PASS
    - Execute preservation property tests from task 2 → should PASS
  - Verify no test failures or regressions
  - Confirm:
    - [ ] Bug condition test passes (bug is fixed)
    - [ ] Preservation tests pass (no regressions)
    - [ ] All related contract tests pass (integration with other functions)
    - [ ] Contract compilation succeeds with no errors
  - Document any issues found and resolve them
  - If all tests pass, the fix is complete and verified
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

### Test Framework
- Use the existing test framework from the project (likely Rust testing with `#[test]` or a test harness)
- Follow the pattern established in `smile4money/apps/backend/tests/` for reference

### Property-Based Testing
- For Rust, consider using `quickcheck` or `proptest` crate for property-based testing
- Property-based tests should generate multiple test cases automatically
- Document any seed values or counterexamples found during testing

### File Locations
- Contract implementation: `contracts/escrow/src/lib.rs`
- Error definitions: `contracts/escrow/src/errors.rs`
- Match model: `contracts/escrow/src/models/` (if separated)
- Tests: `contracts/escrow/tests/` or inline tests

### References
- Bug Condition Specification: See `design.md` section "Bug Details → Bug Condition"
- Expected Behavior: See `design.md` section "Expected Behavior"
- Preservation Requirements: See `design.md` section "Preservation Requirements"
- Testing Strategy: See `design.md` section "Testing Strategy"
