# Release review: <release tag>

Copy this file to `docs/release-reviews/<release tag>.md`, fill in every row, and merge it before
running `Deploy to Mainnet`. Gate definitions and thresholds:
[runbook.md §8](../runbook.md#8-production-readiness-gates). Validate with
`python scripts/check_release_review.py docs/release-reviews/<release tag>.md`.

- **Release:** <tag> (commit `<sha>`)
- **Review date (UTC):** <YYYY-MM-DD>
- **Soak window:** <start> → <end> (≥ 14 days)
- **Release manager:** <name>

## Gate results

Result is one of `PASS`, `FAIL`, `WAIVED`. A row with no evidence link counts as FAIL.

| Gate | Measured | Result | Evidence | Owner |
|---|---|---|---|---|
| G1 | <e.g. 214 settled (61 Lichess / 153 Chess.com, 27 draws); 0 mismatches; 0 double payouts> | <PASS/FAIL> | <link> | <name> |
| G2 | <p95 / p99 / max> | <PASS/FAIL> | <link> | <name> |
| G3 | <DLQ depth at end; slowest resolution; evictions; alert test> | <PASS/FAIL> | <link> | <name> |
| G4 | <pause / rotation / rollback drill times and dates> | <PASS/FAIL> | <link> | <name> |
| G5 | <backup interval; restore time; entries before/after restart> | <PASS/FAIL/WAIVED> | <link> | <name> |
| G6 | <load level; p95; 5xx; 429; RPC errors> | <PASS/FAIL/WAIVED> | <link> | <name> |
| G7 | <CI run; audit; compatibility run; WASM hash match> | <PASS/FAIL> | <link> | <name> |
| G8 | <dry run score; response times; guide/status page links> | <PASS/FAIL/WAIVED> | <link> | <name> |

## Waivers

Only G5, G6 and G8 may be waived. Delete this table if there are none.

| Gate | Reason | Mitigation | Expires (UTC, ≤ 14 days after launch) | Approved by release manager | Approved by contract admin keyholder |
|---|---|---|---|---|---|
| <G5/G6/G8> | <why> | <what limits the risk meanwhile> | <YYYY-MM-DD> | <name> | <name> |

## Decision

- **Decision:** <GO / NO-GO>
- **Release manager sign-off:** <name, date>
- **Contract admin keyholder sign-off:** <name, date>
