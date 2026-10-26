# Bugfix Requirements Document

## Introduction

This document specifies the requirements for fixing Issue #6: the `submit_result()` function does not verify that the `game_id` from the result submission matches the `game_id` stored in the match record.

The bug poses a critical cross-match result injection vulnerability: if an oracle submits a result with a valid match_id but a game_id that belongs to a different match, the result would be applied to the wrong match. This could result in incorrect payouts, stolen funds, or manipulation of match outcomes.

For example, if match_id=1 has game_id="abc123" and match_id=2 has game_id="xyz789", an attacker could submit a result with match_id=1 and game_id="xyz789", incorrectly applying match_id=2's result to match_id=1.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an oracle submits a result with a valid match_id and a game_id that exists in the store but does NOT match the game_id stored in the match record identified by match_id THEN the function accepts the result and applies it to the wrong match

1.2 WHEN verifyGameResult() is called with matchId=1 and gameId="xyz789" (where match_id=1 actually has gameId="abc123") THEN the function finds the match record by gameId="xyz789", fails to verify that it corresponds to the requested match_id=1, and proceeds with result verification using the mismatched record

### Expected Behavior (Correct)

2.1 WHEN an oracle submits a result with matchId=1 and gameId="xyz789" (where match_id=1 has gameId="abc123") THEN the function SHALL detect the game_id mismatch, return a validation error, and reject the submission without applying any result

2.2 WHEN verifyGameResult() is called with matchId and gameId THEN the function SHALL first find the match by gameId, then verify that match.matchId equals the requested matchId before proceeding with player identity verification

2.3 WHEN a game_id mismatch is detected THEN the function SHALL return a validation error indicating that the game_id does not match the stored record for the given match_id

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an oracle submits a result with the CORRECT matchId and gameId that match the stored record THEN the function SHALL CONTINUE TO fetch the game result from the chess platform API and verify player identities normally

3.2 WHEN an oracle submits a result and the game_id is not found in the store at all THEN the function SHALL CONTINUE TO return "Match not found" error as before

3.3 WHEN player identities fail to verify (players don't match) THEN the function SHALL CONTINUE TO return "Player identity verification failed" error (validation should still occur after game_id check passes)

3.4 WHEN the match record lacks captured player identities THEN the function SHALL CONTINUE TO return "Player identities not recorded" error

3.5 WHEN the platform in the request doesn't match the match's recorded platform THEN the function SHALL CONTINUE TO return "Platform mismatch" error

3.6 WHEN all validations pass and the game result is correctly verified THEN the function SHALL CONTINUE TO return success with the verified game result ready for blockchain submission
