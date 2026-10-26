# Implementation Tasks

## Phase Overview

This phase covers implementing the game_id validation check and comprehensive testing.

---

## 1. Implementation

### 1.1 Add Game ID Validation Check
- [ ] Edit `apps/backend/src/services/oracle-service.ts`
- [ ] In the `verifyGameResult()` function, after the "Fetch the match record" block (after `const match = await store.findByGameId(gameId);`)
- [ ] Insert validation check: `if (match.matchId !== matchId)` returning `GameIdMismatch` error
- [ ] Verify the check occurs before player identity validation
- [ ] Ensure error message is clear: "The game_id belongs to a different match"
- [ ] Update code comments to document this guard

### 1.2 Verify Error Handling
- [ ] Confirm the error uses appropriate HTTP status code (400 Validation Error)
- [ ] Verify error envelope structure matches existing patterns
- [ ] Test that error response includes both `error` and `details` fields
- [ ] Ensure error message clearly indicates the mismatch

---

## 2. Unit Tests

### 2.1 Test Mismatched Game ID Rejection
- [ ] Create test case: `test('verifyGameResult rejects mismatched game_id and match_id')`
- [ ] Setup: Create two matches with different game IDs
- [ ] Action: Call verifyGameResult with match_id=1 but game_id from match_id=2
- [ ] Assert: Function returns `ok: false` with error indicating mismatch
- [ ] Verify error status is 400 (validation error)
- [ ] Verify error message mentions the mismatch

### 2.2 Test Correct Pair Passes Validation
- [ ] Create test case: `test('verifyGameResult accepts correct match_id and game_id pair')`
- [ ] Setup: Create match with known game_id
- [ ] Action: Call verifyGameResult with correct match_id and game_id
- [ ] Assert: Validation check passes and function continues to player verification
- [ ] Note: This may fail on player verification (expected) but should NOT fail on game_id check

### 2.3 Test With Multiple Matches in Store
- [ ] Create test case: `test('verifyGameResult distinguishes between multiple matches')`
- [ ] Setup: Create 3 matches with different game IDs
- [ ] Action 1: Submit result with correct match_id and game_id → should pass game_id check
- [ ] Action 2: Submit result with wrong match_id but existing game_id → should fail
- [ ] Assert: Correct pair proceeds, incorrect pair is rejected
- [ ] Verify no cross-contamination between matches

### 2.4 Property-Based Test: Fix Checking
- [ ] Create PBT: `test('property: game_id mismatch always rejects')`
- [ ] Generate: Random match_ids and game_ids where `store[gameId].matchId ≠ requestedMatchId`
- [ ] Property: `verifyGameResult(matchId, gameId)` returns `{ ok: false, error: "..." }`
- [ ] Run with 100+ generated test cases
- [ ] Verify 100% rejection rate for mismatched pairs

### 2.5 Property-Based Test: Preservation Checking
- [ ] Create PBT: `test('property: correct matches behave identically')`
- [ ] Generate: Random valid match_id/game_id pairs from store
- [ ] Property: Both old and new implementations accept/reject with same result
- [ ] Note: May use mocked player verification to isolate the game_id check
- [ ] Run with 100+ generated test cases
- [ ] Verify identical behavior for valid pairs

---

## 3. Integration Tests

### 3.1 Full Flow With Correct Game ID
- [ ] Create test: `test('integration: full oracle flow with correct match_id and game_id')`
- [ ] Setup: Create match with game_id="abc123"
- [ ] Action: POST /api/oracle/submit-result with matchId=1, gameId="abc123"
- [ ] Assert: Returns 200 with verified game result
- [ ] Verify player verification succeeds

### 3.2 Full Flow With Mismatched Game ID
- [ ] Create test: `test('integration: oracle rejects mismatched game_id')`
- [ ] Setup: Create two matches (m1 with gameId="abc123", m2 with gameId="xyz789")
- [ ] Action: POST /api/oracle/submit-result with matchId=1, gameId="xyz789"
- [ ] Assert: Returns 400 with error "Game ID mismatch" or similar
- [ ] Verify response structure matches error envelope format
- [ ] Verify match_id=1 is unaffected

### 3.3 Cross-Match Injection Attempt
- [ ] Create test: `test('integration: prevents cross-match result injection')`
- [ ] Setup: Two active matches with results pending
- [ ] Action: Try to inject match_id=2's result into match_id=1
- [ ] Assert: Blockchain receives only legitimate match_id=1 result
- [ ] Verify no result submitted for wrong match

### 3.4 Error Response Structure
- [ ] Create test: `test('integration: game_id mismatch error format')`
- [ ] Action: Call endpoint with mismatched IDs
- [ ] Assert: Response has `error`, `details`, and consistent HTTP status
- [ ] Verify details include both the game_id and the actual match_id it belongs to

---

## 4. Backward Compatibility Verification

### 4.1 Run Existing Oracle Tests
- [ ] Execute: `npm test -- oracle.test.ts`
- [ ] Verify: All existing tests still pass
- [ ] Check: No test failures in oracle or oracle-submit modules
- [ ] Confirm: Existing correct submissions unaffected

### 4.2 Run Integration Tests
- [ ] Execute: `npm test -- integration`
- [ ] Verify: All match lifecycle integration tests pass
- [ ] Confirm: Match creation, deposit, submit_result, finalize flows work
- [ ] Check: No regressions in full-flow scenarios

### 4.3 Platform Mismatch Still Rejected
- [ ] Verify: Platform check still occurs and rejects correctly
- [ ] Confirm: Game ID check doesn't bypass platform validation
- [ ] Test: Mismatched platform with correct game_id still rejected

### 4.4 Player Identity Validation Still Occurs
- [ ] Verify: Player identity checks still occur after game_id passes
- [ ] Confirm: Wrong players still rejected even if game_id matches
- [ ] Test: Correct game_id but wrong players still rejected

---

## 5. Code Review & Documentation

### 5.1 Code Quality
- [ ] Review: Implementation follows project style and conventions
- [ ] Verify: No console.logs or debug code left in
- [ ] Check: Error handling is consistent with existing patterns
- [ ] Confirm: Comments explain the security rationale

### 5.2 Documentation Updates
- [ ] Update: Code comments in `oracle-service.ts`
- [ ] Add: JSDoc comment explaining the game_id validation check
- [ ] Document: Error condition and when it occurs
- [ ] Verify: SECURITY.md mentions this validation

### 5.3 Test Documentation
- [ ] Add: Comments explaining what each test validates
- [ ] Document: Property specifications for PBT tests
- [ ] Explain: Why each scenario matters for security

---

## 6. Deployment Checklist

### 6.1 Pre-Deployment
- [ ] All tests pass locally
- [ ] No TypeScript errors or warnings
- [ ] No new dependencies added
- [ ] Code review completed and approved

### 6.2 Validation
- [ ] Deployment is backward compatible (no breaking changes)
- [ ] Error responses match established patterns
- [ ] No database migrations required
- [ ] No environment variable changes needed

### 6.3 Post-Deployment Monitoring
- [ ] Monitor logs for new "Game ID mismatch" errors (should be rare/zero)
- [ ] Verify oracle submissions continue normally
- [ ] Check that no legitimate submissions are rejected
- [ ] Alert if mismatch errors spike (indicates attack attempt or bug)

---

## Task Execution Order

**Recommended execution sequence:**

1. **Implement 1.1-1.2** (5-10 min)
   - Make the code change
   - Verify compilation

2. **Write 2.1-2.3** (15-20 min)
   - Basic unit tests for new validation
   - Ensure the check works correctly

3. **Run 4.1-4.4** (10 min)
   - Verify no regressions
   - Confirm existing tests still pass

4. **Write 2.4-2.5** (20-30 min)
   - Create property-based tests
   - Run 100+ generated cases

5. **Write 3.1-3.4** (15-20 min)
   - Integration tests from API perspective
   - Verify full flow works

6. **Complete 5.1-5.3** (10 min)
   - Documentation and code review
   - Verify all patterns consistent

7. **Deploy 6.1-6.3** (varies)
   - Final checks and deployment
   - Monitor post-deployment

---

## Acceptance Criteria

All tasks must satisfy:

✅ **Correctness**: Mismatched game_id/match_id pairs are always rejected  
✅ **Preservation**: Correct pairs work exactly as before  
✅ **Testing**: Property-based tests verify both conditions with 100+ cases  
✅ **Integration**: Full oracle flow works end-to-end  
✅ **Backward Compatibility**: All existing tests pass  
✅ **Documentation**: Code and tests are well-commented  
✅ **Deployment**: Ready for immediate production deployment
