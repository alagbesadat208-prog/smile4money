# Bugfix Requirements Document

## Introduction

This document specifies the requirements for fixing Issue #5: game_id charset validation does not reject Unicode characters.

The bug allows game_id values containing Unicode characters to be accepted when only ASCII alphanumeric characters, hyphens, and underscores should be permitted per the documented API specification. This violates the documented charset policy and could cause issues with downstream systems that expect ASCII-only game identifiers.

The API reference documentation clearly specifies that the accepted character set for game_id is `[A-Za-z0-9_-]` (uppercase letters, lowercase letters, digits, underscore, hyphen). Currently, the validation does not enforce this restriction, allowing Unicode characters (emoji, accented letters, etc.) to pass through.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a game_id containing Unicode characters (e.g., "game_α123", "game😀", "gäme123") is submitted to the `/api/validate-game` endpoint THEN the system accepts the game_id without validation error

1.2 WHEN a game_id is provided to `validateGameInput()` with non-ASCII characters THEN the system does not reject it and returns null (indicating valid input)

1.3 WHEN the charset validation is missing THEN any string of valid length containing Unicode characters passes validation, even though it violates the documented API contract

### Expected Behavior (Correct)

2.1 WHEN a game_id containing Unicode characters is submitted to the `/api/validate-game` endpoint THEN the system SHALL reject it with HTTP 400 and error message "gameId contains invalid characters"

2.2 WHEN a game_id is provided to `validateGameInput()` with non-ASCII characters THEN the system SHALL return error message "gameId contains invalid characters"

2.3 WHEN a game_id contains only characters from the allowed set `[A-Za-z0-9_-]` THEN the system SHALL accept it and return null from `validateGameInput()`

2.4 WHEN a game_id contains one or more Unicode characters or other non-ASCII characters THEN the system SHALL detect the invalid characters and reject the game_id

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a game_id is valid ASCII alphanumeric with hyphens and underscores (e.g., "game-123", "game_abc", "Game123") THEN the system SHALL CONTINUE TO accept it

3.2 WHEN a game_id is empty or missing THEN the system SHALL CONTINUE TO return "gameId is required" error

3.3 WHEN a game_id is >= 512 characters THEN the system SHALL CONTINUE TO return "gameId is too long" error

3.4 WHEN a game_id is valid after charset validation THEN the system SHALL CONTINUE TO process platform and username validation as before

3.5 WHEN validation passes THEN the system SHALL CONTINUE TO fetch game results from the appropriate platform API

3.6 WHEN a valid game is found on the platform THEN the system SHALL CONTINUE TO return success with game details (players, status, etc.)

