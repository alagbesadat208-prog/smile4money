# Implementation Plan: Game ID Charset Validation Fix

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
  - **Property 1: Bug Condition** - Reject Invalid Game ID Charset
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: For deterministic bugs, scope the property to concrete failing case(s) to ensure reproducibility
  
  **Test Implementation Details** (from Bug Condition in design):
  - Test what happens when `validateGameInput()` receives game_ids with non-ASCII characters:
    1. Call `validateGameInput({ gameId: "game_α123", platform: "lichess" })`
    2. Call `validateGameInput({ gameId: "game😀", platform: "lichess" })`
    3. Call `validateGameInput({ gameId: "gäme123", platform: "lichess" })`
    4. Call `validateGameInput({ gameId: "game@123", platform: "lichess" })`
    5. Call `validateGameInput({ gameId: "game.123", platform: "lichess" })`
  
  - Test Assertion (from Expected Behavior in design):
    - On unfixed code: All calls return `null` (BUG - should reject)
    - On fixed code: All calls return `"gameId contains invalid characters"`
  
  - Test Scenarios:
    1. **Unicode Letter (Greek alpha)**: gameId with α character should be rejected
    2. **Emoji**: gameId with emoji should be rejected
    3. **Accented Letter**: gameId with ä character should be rejected
    4. **Special Symbol (@)**: gameId with @ should be rejected
    5. **Period Character**: gameId with . should be rejected
  
  - Test Assertions Should Match Expected Behavior Properties:
    - `validateGameInput(input)` returns `"gameId contains invalid characters"` for ALL inputs where `isBugCondition(input)` is true
    - Error message is returned early (before platform validation)
  
  - Also test the API endpoint `/api/validate-game`:
    - POST with gameId containing Unicode characters should return HTTP 400 with error.code = "VALIDATION_ERROR" and error.message = "gameId contains invalid characters"
  
  - **Run test on UNFIXED code**
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found to understand root cause:
    - Example: "validateGameInput({gameId: 'game_α123', platform: 'lichess'}) returns null instead of 'gameId contains invalid characters', allowing Unicode characters through"
  
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3_

---

## Task 2: Preservation Property Tests

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Accept Valid ASCII Game IDs
  - **IMPORTANT**: Follow observation-first methodology
  - **CRITICAL**: These tests MUST PASS on unfixed code - they capture baseline behavior to preserve
  
  **Observation Phase** (on unfixed code):
  - Observe: Call `validateGameInput({ gameId: "game-123", platform: "lichess" })` → returns `null` (valid)
  - Observe: Call `validateGameInput({ gameId: "game_123", platform: "lichess" })` → returns `null` (valid)
  - Observe: Call `validateGameInput({ gameId: "Game_123-abc", platform: "lichess" })` → returns `null` (valid)
  - Observe: Call `validateGameInput({ gameId: "GAME123", platform: "lichess" })` → returns `null` (valid)
  - Observe: Call `validateGameInput({ gameId: "", platform: "lichess" })` → returns `"gameId is required"` (early exit for empty)
  - Observe: Call `validateGameInput({ gameId: "x".repeat(512), platform: "lichess" })` → returns `"gameId is too long"` (length check)
  
  **Test Implementation Details** (from Preservation Requirements in design):
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements
  - Property-based testing generates many test cases for stronger guarantees
  - Test Scenarios:
    1. **Valid Alphanumeric Preservation**: Generate random game_ids with only `[A-Za-z0-9]` → should all return `null` from `validateGameInput()` (valid inputs pass through)
    2. **Valid With Hyphens Preservation**: Generate random game_ids with `[A-Za-z0-9-]` → should all return `null` (hyphens allowed, must continue to work)
    3. **Valid With Underscores Preservation**: Generate random game_ids with `[A-Za-z0-9_]` → should all return `null` (underscores allowed, must continue to work)
    4. **Valid Mixed Allowed Chars Preservation**: Generate random game_ids with `[A-Za-z0-9_-]` in various combinations → should all return `null`
    5. **Empty String Still Rejected**: gameId="" should still return "gameId is required" (not charset error)
    6. **Length Check Still Works**: gameId with 512+ characters should still return "gameId is too long" (not charset error)
    7. **Platform Still Validated**: If valid gameId but platform="invalid" → should return platform error (not pass through completely)
    8. **Endpoint Accepts Valid IDs**: POST /api/validate-game with valid ASCII game_id should not fail with charset error (returns 200 or 404, not 400)
  
  - **Run tests on UNFIXED code**
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  
  - Property Assertions:
    - For all non-buggy inputs (gameId contains ONLY `[A-Za-z0-9_-]`), `validateGameInput()` returns `null` (or error for other validations, but NOT charset error)
    - Existing validation checks (required, length, platform, username) continue to function as before
    - Valid ASCII game_ids pass through charset validation untouched
    - All other validation errors still appear in proper order
  
  - Mark task complete when tests are written, run, and PASSING on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

---

## Task 3: Fix Implementation

- [ ] 3. Fix for game_id charset validation

  - [ ] 3.1 Implement charset validation in validateGameInput() and validateSubmitResultInput()
    - **Location**: `apps/backend/src/services/validate-game-service.ts` and `apps/backend/src/services/oracle-service.ts`
    - **Implementation Details**:
      1. Create helper function `isValidGameIdCharset(gameId: string): boolean` in validate-game-service.ts
      2. Use regex pattern `/^[A-Za-z0-9_-]*$/` to validate charset (matches only allowed characters)
      3. Add charset check in `validateGameInput()` after length check but before platform validation
      4. Add same charset check in `validateSubmitResultInput()` in oracle-service.ts after gameId presence check
      5. Return error message "gameId contains invalid characters" when charset validation fails
      6. Add JSDoc comments documenting the validation
    
    - **Code Pattern**:
      ```typescript
      /**
       * Validate that gameId contains only allowed characters [A-Za-z0-9_-]
       * per API specification.
       */
      function isValidGameIdCharset(gameId: string): boolean {
        return /^[A-Za-z0-9_-]*$/.test(gameId);
      }
      
      // In validateGameInput():
      if (!isValidGameIdCharset(gameId)) {
        return 'gameId contains invalid characters';
      }
      ```
    
    - **Placement**: Charset check should be early in validation sequence (after required/length checks, before platform/username)
    - **Atomicity**: Validation happens at input boundary, no side effects
    - **Consistency**: Same validation applied to both validate-game and oracle endpoints
    
    - _Bug_Condition: isBugCondition(input) where input.gameId CONTAINS ANY character NOT IN [A-Za-z0-9_-]_
    - _Expected_Behavior: expectedBehavior(result) = "gameId contains invalid characters" returned early in validation_
    - _Preservation: All gameIds with ONLY [A-Za-z0-9_-] characters should pass charset check and continue validation as before_
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Reject Invalid Game ID Charset
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - **Run bug condition exploration test from step 1**
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - **Verification Checklist**:
      - Unicode letter case: validateGameInput rejects gameId with α → returns "gameId contains invalid characters"
      - Emoji case: validateGameInput rejects gameId with emoji → returns error message
      - Accented letter case: validateGameInput rejects gameId with ä → returns error message
      - Special symbol case: validateGameInput rejects gameId with @ and . → returns error message
      - API endpoint case: POST /api/validate-game returns HTTP 400 with VALIDATION_ERROR for all invalid inputs
    - All test assertions from task 1 should now pass
    - _Requirements: Expected Behavior Properties from design (2.1, 2.2, 2.3, 2.4)_

  - [ ] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Accept Valid ASCII Game IDs
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - **Run preservation property tests from step 2**
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - **Verification Checklist**:
      - Valid alphanumeric gameIds: still return null (pass through validation)
      - Valid with hyphens: still return null
      - Valid with underscores: still return null
      - Valid with mixed allowed chars: still return null
      - Empty string: still returns "gameId is required"
      - Length check: still returns "gameId is too long" for long IDs
      - Platform validation: still validates platform after charset passes
      - API endpoint: returns 200/404 for valid ASCII gameIds (not 400)
    - Confirm all tests from task 2 still pass after fix (no regressions)
    - _Requirements: Preservation Requirements from design (3.1, 3.2, 3.3, 3.4, 3.5, 3.6)_

---

## Task 4: Checkpoint - Ensure All Tests Pass

- [ ] 4. Checkpoint - Ensure all tests pass
  - Run complete test suite for the charset validation fix:
    - Execute bug condition exploration test from task 1 → should PASS
    - Execute preservation property tests from task 2 → should PASS
    - Run: `npm run test -- validate-game-service.test.ts`
    - Run: `npm run test -- oracle-service.test.ts`
    - Run: `npm run test -- validate-game.test.ts`
    - Run: `npm run test -- oracle-route.test.ts`
  - Verify no test failures or regressions
  - Confirm:
    - [ ] Bug condition test passes (bug is fixed)
    - [ ] Preservation tests pass (no regressions)
    - [ ] All validate-game tests pass
    - [ ] All oracle tests pass
    - [ ] Full test suite passes (`npm test`)
    - [ ] Build completes without errors
  - Document any issues found and resolve them
  - If all tests pass, the fix is complete and verified
  - Ensure all tests pass, ask the user if questions arise.

