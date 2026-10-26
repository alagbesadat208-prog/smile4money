# Bugfix Requirements Document

## Introduction

This document specifies the requirements for fixing Issue #8: preventing the `emergency_drain()` function from being callable while a match is in the `Active` state. 

The bug poses a critical security and data integrity risk: if `emergency_drain` were callable during active matches, an admin could drain the contract's entire balance while player stakes are locked in escrow for ongoing games. This would result in stealing player funds, as the contract would no longer have sufficient balance to pay out match results.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN both players have deposited into a match (transitioning it to `Active` state) AND the contract is paused AND `emergency_drain()` is called THEN the function executes successfully and drains all funds from the contract, leaving no balance for active match payouts

1.2 WHEN a match remains in `Active` state with both players' stakes locked AND `emergency_drain()` is invoked THEN the function executes without any guard or check against active matches, silently allowing the drain to proceed

### Expected Behavior (Correct)

2.1 WHEN both players have deposited into a match (match is in `Active` state) AND the contract is paused AND `emergency_drain()` is called THEN the function SHALL return `Err(Error::ActiveMatchExists)` and reject the drain operation

2.2 WHEN the contract is paused AND one or more matches exist in `Active` state AND `emergency_drain()` is invoked THEN the function SHALL iterate through all matches, detect the `Active` state condition, and reject the drain with `Error::ActiveMatchExists` before any funds are transferred

### Unchanged Behavior (Regression Prevention)

3.1 WHEN no matches exist in `Active` state AND the contract is paused AND `emergency_drain()` is called THEN the function SHALL CONTINUE TO execute successfully and drain the contract's entire balance to the pre-registered `safe_address`

3.2 WHEN all existing matches are in terminal states (`Completed` or `Cancelled`) AND the contract is paused AND `emergency_drain()` is called THEN the function SHALL CONTINUE TO proceed normally without rejecting the drain operation

3.3 WHEN `emergency_drain()` is called without pausing the contract first THEN the function SHALL CONTINUE TO return `Err(Error::NotPaused)` (existing pause guard)

3.4 WHEN a non-admin address calls `emergency_drain()` THEN the function SHALL CONTINUE TO return `Err(Error::Unauthorized)` (existing authorization guard)

3.5 WHEN a match transitions from `Active` to `Completed` (result finalized) THEN the function SHALL CONTINUE TO allow `emergency_drain` to proceed in subsequent calls

3.6 WHEN a match transitions from `Active` to `Cancelled` (e.g., via timeout or mutual cancellation) THEN the function SHALL CONTINUE TO allow `emergency_drain` to proceed in subsequent calls
