# Design Document

## Overview

This design document outlines the strategy for fixing Issue #6: adding game_id validation to the `submit_result()` function to prevent cross-match result injection.

The fix is minimal and surgical: after fetching the match record by gameId, we add a single validation check to ensure that the retrieved match's matchId equals the matchId provided in the request.

## Problem Analysis

### Root Cause

The `verifyGameResult()` function in `oracle-service.ts` accepts two parameters:
- `matchId` (from the request body)
- `gameId` (from the request body)

The current flow:
1. Calls `store.findByGameId(gameId)` to fetch the match record
2. Never verifies that `match.matchId === matchId`
3. Proceeds with player identity verification on the incorrectly matched record

This allows an attacker to provide a mismatched pair and have the oracle apply results to the wrong match.

### Attack Scenario

```
Attacker submits: { matchId: 1, gameId: "xyz789" }
Actual data:
  - match_id=1 has gameId="abc123"
  - match_id=2 has gameId="xyz789"

Current behavior:
  - Finds match by gameId="xyz789" → gets match_id=2
  - Verifies players from match_id=2's record
  - Returns success, oracle applies result to match_id=2
  - Blockchain receives submit_result(1, "xyz789") which fails or misapplies

Result: Confusion, potential fund loss, or incorrect payouts
```

## Solution Design

### Implementation Strategy

Add a game_id consistency check immediately after fetching the match record in `verifyGameResult()`.

**Location:** `apps/backend/src/services/oracle-service.ts` in the `verifyGameResult()` function

**Change:** After the line:
```typescript
const match = await store.findByGameId(gameId);
```

Insert:
```typescript
// Ensure the retrieved match's ID matches the requested match ID
if (match.matchId !== matchId) {
  return {
    ok: false,
    status: errorToHttpStatus(new ValidationError('Game ID mismatch')),
    error: 'Game ID mismatch',
    details: `The game_id "${gameId}" belongs to match ${match.matchId}, but match ${matchId} was requested.`,
  };
}
```

This check occurs:
- After confirming the gameId exists in the store
- Before any player identity verification
- Before any player identity hash checks
- Before returning success

### Validation Order

The corrected flow will be:

1. ✅ Fetch match by gameId
2. ✅ **[NEW] Verify match.matchId === requested matchId**
3. ✅ Verify player identities were captured
4. ✅ Verify platform matches
5. ✅ Fetch game result from chess API
6. ✅ Verify players from API match registered players
7. ✅ Verify identity hash consistency
8. ✅ Return success

### Testing Implications

The fix requires:
- **Unit tests** for the new validation (happy path and error case)
- **Integration tests** to verify end-to-end flow with mismatched IDs
- **No changes** to existing tests that use correct match_id/game_id pairs

### Bug Condition and Property Specification

**Bug Condition Function:**
```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type SubmitResultInput
  OUTPUT: boolean
  
  LET match ← store.findByGameId(X.gameId)
  RETURN match EXISTS AND match.matchId ≠ X.matchId
END FUNCTION
```

Identifies inputs where the gameId exists but corresponds to a different match.

**Fix Checking Property (Buggy Inputs):**
```pascal
// Property: Cross-Match Prevention
FOR ALL X WHERE isBugCondition(X) DO
  result ← verifyGameResult'(X)
  ASSERT result.ok = false AND result.error = "Game ID mismatch"
END FOR
```

The fixed function must reject all mismatched pairs.

**Preservation Checking Property (Non-Buggy Inputs):**
```pascal
// Property: Correct Matches Pass Through
FOR ALL X WHERE NOT isBugCondition(X) DO
  resultOld ← verifyGameResult(X)
  resultNew ← verifyGameResult'(X)
  ASSERT resultOld.ok = resultNew.ok AND resultOld.error = resultNew.error
END FOR
```

For all correctly paired match_id/game_id combinations, the behavior remains identical.

### Code Impact Summary

| File | Changes | Risk |
|------|---------|------|
| `oracle-service.ts` | Add 1 validation check (~8 lines) | Low - new validation, no behavior change to existing paths |
| `oracle.test.ts` | Add 2-3 test cases | Low - new tests only |
| `integration tests` | Add 1-2 scenarios | Low - new scenarios only |

### Backward Compatibility

✅ **Fully backward compatible**
- Existing correct submissions (where matchId and gameId match) are unaffected
- Only rejects previously-accepted but incorrect submissions
- No changes to response structure or success path

### Deployment Safety

✅ **Safe to deploy immediately**
- No database migrations needed
- No configuration changes required
- No service dependencies added
- Rejection is a safety measure (making things more strict, not looser)

## Acceptance Criteria Testability Analysis

1.1 (Defect): Rejects mismatched gameId → **Testable as property** (verify rejection)
1.2 (Defect): Function doesn't verify correspondence → **Testable as property** (verify new check exists)

2.1 (Correct): Game_id mismatch detected and rejected → **Testable as property**
2.2 (Correct): Validation after finding by gameId → **Testable as example**
2.3 (Correct): Returns validation error on mismatch → **Testable as property**

3.1-3.6 (Unchanged): All existing validations work → **Testable as properties** (preservation checks)
