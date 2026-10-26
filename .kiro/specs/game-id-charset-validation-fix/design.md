# Game ID Charset Validation Bugfix Design

## Overview

This document specifies the technical design for implementing game_id charset validation to enforce the documented policy that game_id values must contain only ASCII alphanumeric characters, hyphens, and underscores (`[A-Za-z0-9_-]`). Currently, the system accepts Unicode characters in game_id values, which violates the documented API specification and could cause issues with downstream systems expecting ASCII-only identifiers.

The fix adds a charset validation check in both the validate-game and oracle submit-result endpoints to reject any game_id containing non-ASCII or non-allowed characters, while preserving all existing behavior for valid inputs.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug - when game_id contains characters outside the allowed set `[A-Za-z0-9_-]`
- **Property (P)**: The desired behavior when the bug condition is detected - the system should reject the input with error message "gameId contains invalid characters"
- **Preservation**: Existing behavior for valid game_ids (ASCII alphanumeric with hyphens and underscores) that must remain unchanged by the fix
- **validateGameInput()**: The validation function in `apps/backend/src/services/validate-game-service.ts` that validates game_id, platform, and username for the validate-game endpoint
- **validateSubmitResultInput()**: The validation function in `apps/backend/src/services/oracle-service.ts` that validates matchId, gameId, platform, and username for the oracle submit-result endpoint
- **isValidGameIdCharset()**: A utility function that checks if a game_id contains only allowed characters from the set `[A-Za-z0-9_-]`

## Bug Details

### Bug Condition

The bug manifests when a user submits a game_id containing Unicode characters (or other non-ASCII characters) to either the `/api/validate-game` or `/api/oracle/submit-result` endpoints. The validation functions in `validateGameInput()` and `validateSubmitResultInput()` currently check for presence and length but do NOT validate the character set, allowing Unicode and special characters to pass through when they should be rejected per the documented API specification.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input - a game_id string
  OUTPUT: boolean
  
  // Returns true when input contains any character NOT in [A-Za-z0-9_-]
  RETURN input CONTAINS ANY character NOT IN [A-Za-z0-9_-]
END FUNCTION
```

### Examples

- **Example 1 - Greek letter**: Submitting `gameId: "game_α123"` to `/api/validate-game` → Currently accepted, should be rejected with "gameId contains invalid characters"
- **Example 2 - Emoji**: Submitting `gameId: "game😀"` to `/api/validate-game` → Currently accepted, should be rejected with "gameId contains invalid characters"
- **Example 3 - Accented letter**: Submitting `gameId: "gäme123"` to `/api/oracle/submit-result` → Currently accepted, should be rejected with "gameId contains invalid characters"
- **Example 4 - Invalid symbol**: Submitting `gameId: "game@123"` to `/api/validate-game` → Currently accepted, should be rejected with "gameId contains invalid characters"
- **Example 5 - Valid game_id**: Submitting `gameId: "game-123_ABC"` to `/api/validate-game` → Currently accepted, should CONTINUE to be accepted (preservation)

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Valid game_ids containing only characters from `[A-Za-z0-9_-]` must continue to be accepted
- Validation error "gameId is required" must continue to be returned for missing or empty game_ids
- Validation error "gameId is too long" must continue to be returned for game_ids with length >= 512
- Platform validation must continue to work as before, returning "platform must be lichess or chessdotcom"
- Username validation for chessdotcom must continue to work as before
- Valid games found on the platform must continue to be fetched and returned successfully
- Preservation of all downstream processing after charset validation passes

**Scope:**
All inputs that do NOT contain invalid characters (non-ASCII or characters outside `[A-Za-z0-9_-]`) should be completely unaffected by this fix. This includes:
- Valid ASCII alphanumeric game_ids (e.g., "game123", "GAME", "123")
- Game_ids with hyphens (e.g., "game-123", "match-1")
- Game_ids with underscores (e.g., "game_123", "match_1")
- Game_ids with mixed valid characters (e.g., "Game_123-abc")
- All error paths for other validation checks (length, presence, platform, username)

## Hypothesized Root Cause

Based on the bug description and code review, the root cause is:

1. **Missing Charset Validation**: The validation functions `validateGameInput()` and `validateSubmitResultInput()` do not include a charset validation check. The functions validate presence, length, and platform/username requirements but skip character set validation entirely.

2. **No Regex or Whitelist Check**: The code lacks any regex pattern or character set validation logic that would detect and reject non-ASCII or non-allowed characters.

3. **JavaScript String Handling**: JavaScript's default string handling accepts any Unicode character without restriction, and the validation code does not explicitly enforce ASCII-only limitations.

4. **Inconsistent with Documentation**: The API documentation specifies the charset as `[A-Za-z0-9_-]`, but the code does not enforce this specification, creating a gap between documented and actual behavior.

## Correctness Properties

Property 1: Bug Condition - Charset Validation Rejection

_For any_ game_id input where the bug condition holds (isBugCondition returns true, meaning it contains characters outside `[A-Za-z0-9_-]`), the fixed validateGameInput and validateSubmitResultInput functions SHALL return the error message "gameId contains invalid characters", and the endpoint SHALL return HTTP 400 with error code VALIDATION_ERROR.

**Validates: Requirements 2.1, 2.2, 2.4**

Property 2: Preservation - Valid Input Acceptance

_For any_ game_id input where the bug condition does NOT hold (isBugCondition returns false, meaning it contains only characters from `[A-Za-z0-9_-]`), the fixed validation functions SHALL produce exactly the same result as before - they SHALL either return null (validation passed) or return a different validation error (length, presence, platform, username) if applicable, but NOT the charset error. End-to-end behavior for valid game_ids must be completely preserved.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Technical Context

### Components Affected

1. **Backend Validation Service** (`apps/backend/src/services/validate-game-service.ts`)
   - Function: `validateGameInput()`
   - Current: Validates game_id length only (max 512 bytes)
   - Updated: Add charset validation for allowed characters `[A-Za-z0-9_-]`

2. **Backend Oracle Service** (`apps/backend/src/services/oracle-service.ts`)
   - Function: `validateSubmitResultInput()`
   - Current: Validates game_id presence only
   - Updated: Add same charset validation for consistency

3. **API Endpoints**
   - `POST /api/validate-game` - game validation endpoint
   - `POST /api/oracle/submit-result` - result submission endpoint

### Validation Points

Charset validation should be applied at two points where game_id is accepted from user input:

1. **Validate-Game Endpoint** (`/api/validate-game`)
   - Route: `apps/backend/src/routes/validate-game.ts`
   - Calls: `validateGameInput()` before game fetching
   - Error response: HTTP 400 with VALIDATION_ERROR

2. **Oracle Submit Endpoint** (`/api/oracle/submit-result`)
   - Route: `apps/backend/src/routes/oracle.ts`
   - Calls: `validateSubmitResultInput()` before result verification
   - Error response: HTTP 400 with VALIDATION_ERROR

### Validation Logic

A utility function should be created to check game_id charset compliance:

```typescript
/**
 * Check if a game_id contains only allowed characters [A-Za-z0-9_-]
 * 
 * @param gameId - The game identifier to validate
 * @returns true if gameId contains only allowed characters, false otherwise
 */
function isValidGameIdCharset(gameId: string): boolean
```

Implementation approach:
- Use regex pattern: `/^[A-Za-z0-9_-]*$/`
- Or: use set of allowed characters and check each byte
- Must work with ASCII only (pattern inherently limits to ASCII)

### Error Handling

When charset validation fails:
- **Error message:** "gameId contains invalid characters"
- **HTTP status:** 400 (Bad Request)
- **Error code:** VALIDATION_ERROR
- **Placement in validation flow:** Early in validation chain, after length check but along with other basic validations

### Location of Implementation

**Option A (Recommended - DRY):** Create a shared utility function
- File: `apps/backend/src/services/validate-game-service.ts` or new `apps/backend/src/utils/game-id-validator.ts`
- Function: `isValidGameIdCharset(gameId: string): boolean`
- Used by: Both `validateGameInput()` and `validateSubmitResultInput()`

**Option B:** Duplicate the check in each validation function
- Less desirable: violates DRY principle

## Implementation Design

### File Changes

#### 1. Add Charset Validation Utility (if not in existing file)

File: `apps/backend/src/services/validate-game-service.ts`

Add helper function:
```typescript
/**
 * Validate that gameId contains only allowed characters [A-Za-z0-9_-]
 * per API specification.
 */
function isValidGameIdCharset(gameId: string): boolean {
  // Regex pattern enforces ASCII alphanumeric, hyphen, underscore
  return /^[A-Za-z0-9_-]*$/.test(gameId);
}
```

#### 2. Update validateGameInput()

Current signature and flow:
```typescript
export function validateGameInput(input: Partial<ValidateGameInput>): string | null {
  const { gameId, platform, username } = input;

  if (!gameId || typeof gameId !== 'string' || gameId.length === 0) {
    return 'gameId is required';
  }
  if (gameId.length >= 512) {
    return 'gameId is too long';
  }
  // ADD HERE: Charset validation
  if (!isValidGameIdCharset(gameId)) {
    return 'gameId contains invalid characters';
  }
  if (!platform || (platform !== 'lichess' && platform !== 'chessdotcom')) {
    return 'platform must be lichess or chessdotcom';
  }
  if (platform === 'chessdotcom' && (!username || typeof username !== 'string' || username.length === 0)) {
    return 'username is required for chessdotcom validation to look up game archives';
  }
  return null;
}
```

#### 3. Update validateSubmitResultInput() in oracle-service.ts

Current signature and flow:
```typescript
export function validateSubmitResultInput(input: Partial<SubmitResultInput>): string | null {
  const { matchId, gameId, platform, username } = input;

  if (typeof matchId !== 'number' || !Number.isInteger(matchId) || matchId <= 0) {
    return 'matchId must be a positive integer';
  }
  if (!gameId || typeof gameId !== 'string' || gameId.length === 0) {
    return 'gameId is required';
  }
  // ADD HERE: Charset validation
  if (!isValidGameIdCharset(gameId)) {
    return 'gameId contains invalid characters';
  }
  if (!platform || (platform !== 'lichess' && platform !== 'chessdotcom')) {
    return 'platform must be lichess or chessdotcom';
  }
  if (platform === 'chessdotcom' && (!username || typeof username !== 'string')) {
    return 'username is required for chessdotcom';
  }
  return null;
}
```

### Testing Strategy

#### Unit Tests: validateGameInput()

File: `apps/backend/tests/services/validate-game-service.test.ts`

Add test cases for charset validation:

```typescript
describe('validateGameInput - charset validation', () => {
  it('returns error for gameId with Unicode letter (α)', () => {
    expect(validateGameInput({ gameId: 'game_α123', platform: 'lichess' }))
      .toBe('gameId contains invalid characters');
  });

  it('returns error for gameId with emoji', () => {
    expect(validateGameInput({ gameId: 'game😀', platform: 'lichess' }))
      .toBe('gameId contains invalid characters');
  });

  it('returns error for gameId with accented letter', () => {
    expect(validateGameInput({ gameId: 'gäme123', platform: 'lichess' }))
      .toBe('gameId contains invalid characters');
  });

  it('returns error for gameId with @ symbol', () => {
    expect(validateGameInput({ gameId: 'game@123', platform: 'lichess' }))
      .toBe('gameId contains invalid characters');
  });

  it('returns error for gameId with period', () => {
    expect(validateGameInput({ gameId: 'game.123', platform: 'lichess' }))
      .toBe('gameId contains invalid characters');
  });

  it('returns null for gameId with hyphen', () => {
    expect(validateGameInput({ gameId: 'game-123', platform: 'lichess' }))
      .toBeNull();
  });

  it('returns null for gameId with underscore', () => {
    expect(validateGameInput({ gameId: 'game_123', platform: 'lichess' }))
      .toBeNull();
  });

  it('returns null for gameId with uppercase', () => {
    expect(validateGameInput({ gameId: 'GAME123', platform: 'lichess' }))
      .toBeNull();
  });

  it('returns null for gameId with lowercase', () => {
    expect(validateGameInput({ gameId: 'game123', platform: 'lichess' }))
      .toBeNull();
  });

  it('returns null for gameId with digits', () => {
    expect(validateGameInput({ gameId: '123456', platform: 'lichess' }))
      .toBeNull();
  });

  it('returns null for gameId with mixed case, digits, hyphen, underscore', () => {
    expect(validateGameInput({ gameId: 'Game_123-abc', platform: 'lichess' }))
      .toBeNull();
  });
});
```

#### Unit Tests: validateSubmitResultInput()

File: `apps/backend/tests/services/oracle-service.test.ts`

Add similar test cases:

```typescript
describe('validateSubmitResultInput - charset validation', () => {
  it('returns error for gameId with Unicode characters', () => {
    expect(validateSubmitResultInput({ matchId: 1, gameId: 'game_α', platform: 'lichess' }))
      .toBe('gameId contains invalid characters');
  });

  it('returns error for gameId with emoji', () => {
    expect(validateSubmitResultInput({ matchId: 1, gameId: 'game😀', platform: 'lichess' }))
      .toBe('gameId contains invalid characters');
  });

  it('returns null for gameId with allowed characters', () => {
    expect(validateSubmitResultInput({ matchId: 1, gameId: 'game-123_ABC', platform: 'lichess' }))
      .toBeNull();
  });
});
```

#### Integration Tests

File: `apps/backend/tests/validate-game.test.ts`

Add end-to-end test:

```typescript
it('returns 400 when gameId contains Unicode characters', async () => {
  const response = await request(app)
    .post('/api/validate-game')
    .send({ gameId: 'game_α123', platform: 'lichess' });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(response.body.error.message).toBe('gameId contains invalid characters');
});

it('returns 400 when gameId contains emoji', async () => {
  const response = await request(app)
    .post('/api/validate-game')
    .send({ gameId: 'game😀', platform: 'lichess' });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(response.body.error.message).toBe('gameId contains invalid characters');
});

it('returns 400 when gameId contains invalid symbols', async () => {
  const response = await request(app)
    .post('/api/validate-game')
    .send({ gameId: 'game@123', platform: 'lichess' });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(response.body.error.message).toBe('gameId contains invalid characters');
});

it('accepts gameId with hyphens and underscores', async () => {
  mockedAxios.get.mockResolvedValueOnce({ data: BASE_LICHESS_GAME });
  const response = await request(app)
    .post('/api/validate-game')
    .send({ gameId: 'game-123_abc', platform: 'lichess' });
  // Should not fail with charset error
  expect(response.body.error?.message).not.toBe('gameId contains invalid characters');
});
```

File: `apps/backend/tests/oracle-route.test.ts`

Add similar end-to-end test:

```typescript
it('returns 400 when gameId contains Unicode characters on submit_result', async () => {
  const response = await request(app)
    .post('/api/oracle/submit-result')
    .set('Authorization', `Bearer ${oracleToken}`)
    .send({ matchId: 1, gameId: 'game_α', platform: 'lichess' });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(response.body.error.message).toBe('gameId contains invalid characters');
});
```

## Validation Order

The charset validation check should be placed early in the validation sequence, after checking for presence/emptiness but before platform validation. Order matters for user experience:

1. Check if gameId exists and is not empty → "gameId is required"
2. Check if gameId length is valid → "gameId is too long"
3. **Check if gameId contains only allowed characters → "gameId contains invalid characters"** ← NEW
4. Check if platform is valid → "platform must be lichess or chessdotcom"
5. Check platform-specific requirements (username for chessdotcom)

## Backward Compatibility

- **No breaking changes** to existing APIs
- Valid game_ids that previously passed will continue to pass
- Invalid game_ids containing Unicode will now be rejected (this is the intended fix)
- Error response format remains unchanged
- Clients must be updated to handle the new validation error message

## Security Implications

This fix **improves security**:
- Prevents potential injection of special characters that might be interpreted by downstream systems
- Enforces documented charset policy consistently
- Reduces attack surface by restricting character set at API boundary

## Performance Impact

- **Minimal**: Single regex test per game_id validation
- Regex pattern `/^[A-Za-z0-9_-]*$/` is simple and fast
- Executed only once at route layer before any expensive operations (API calls, database queries)

## Documentation Updates

### Update `docs/api-reference.md`

The documentation already specifies the accepted charset, so no changes needed. However, verify that the error response section documents the new error message:

```markdown
**Error Response Examples:**
- `gameId is required`: game_id field is missing or empty
- `gameId is too long`: game_id exceeds 512 bytes
- `gameId contains invalid characters`: game_id contains characters outside the allowed set [A-Za-z0-9_-]
```

## Related Issues

- Issue #5: game_id charset validation does not reject Unicode characters
- Related to Issue #6 (gameId mismatch check in submit_result)

