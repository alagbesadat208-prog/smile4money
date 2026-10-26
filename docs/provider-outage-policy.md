# Provider Outage Policy

What happens to an active wager when Lichess or Chess.com cannot be reached, what the oracle will and will not do, what operators do, and what players are told.

> **The rule that never bends:** the backend only ever settles a match with a result the platform actually reported. An outage, a timeout, a rate limit, an unreadable response or a missing game never becomes a win, a loss or a draw. If no result can be read, none is submitted.

## What counts as an outage

| Signal | Example | Backend treatment |
|---|---|---|
| Network failure | DNS failure, connection reset, 10 s request timeout | Failed poll attempt, retried |
| Provider server error | HTTP 5xx | Failed poll attempt, retried |
| Unexpected response | Unknown status code, malformed body | Failed poll attempt, retried |
| Rate limiting | HTTP 429 | Treated as "still in progress", retried after `Retry-After`; no attempt is failed |
| Game not found | HTTP 404 (deleted, private, wrong ID) | Failed poll attempt, retried, then dead-lettered |

## Timeline of an active wager during an outage

1. **Polling keeps going.** The poller (`apps/backend/src/services/game-poller.ts`) reports every error as a failed attempt, with the reason, and the polling worker (`apps/backend/src/services/polling.ts`) re-schedules the job. Nothing is submitted on-chain.
2. **Dead-letter after the attempt budget.** When a job reaches `MAX_POLLING_ATTEMPTS` (default 1440 polls, about 12 hours at the default 30 s interval) and the latest poll failed, the job is removed from polling and written to the dead-letter queue with the last failure reason. Still nothing is submitted.
3. **Operator recovery.** While the match is `Active` on-chain, an operator can start polling it again once the provider is back (see *Operator escalation* below). The first successful poll that returns a finished game settles it normally.
4. **On-chain timeout.** If no result is ever submitted, the match stays `Active`. Once `timeout_ledgers` have passed since it became active (default `DEFAULT_TIMEOUT_LEDGERS`, about 7 days), either player can call `claim_timeout`. Both stakes are refunded and the match becomes `Cancelled`.
5. **Mutual cancel at any time.** Both players can call `cancel_match` together while the match is `Active` to get both stakes back immediately, without waiting for the timeout.

The attempt counter counts every poll, including polls of a game still in progress. A game that has run longer than the attempt budget is dead-lettered on its first failed poll after that. Operators should expect long games to appear in the DLQ during an outage, and re-enqueue them.

### Interaction with the dispute window

A result submitted on-chain is pending for the dispute window (`DISPUTE_WINDOW_LEDGERS`, about 1 day) before `finalize_result` pays out, and the admin can `override_result` during that window. An outage that starts **after** a result was submitted does not affect it: the result came from the platform and finalises normally. If an operator has reason to believe a submitted result is wrong, the dispute window is the only time to correct it.

## Operator escalation

| When | Who | Action |
|---|---|---|
| Error rate on `game_poll_api_error` rises for one provider | On-call engineer | Check the provider's status page. Confirm it is the provider, not our egress or credentials (`LICHESS_API_TOKEN`). |
| Provider outage confirmed | On-call engineer | Post a status notice (template below). Record the start time. Do **not** pause the escrow contract: pausing blocks `create_match`, `deposit` and `submit_result` for every match, but `claim_timeout` and `cancel_match` stay available, so it adds nothing for affected players. |
| Outage longer than 6 hours | On-call engineer → engineering lead | Expect dead-letter entries from about 12 hours. Prepare to re-enqueue. Consider pausing new match creation in the frontend for the affected platform. |
| Provider back | On-call engineer | Re-enqueue every DLQ job whose match is still `Active` on-chain. Confirm the results settle. Post the resolution notice. |
| Outage approaching the on-chain timeout (about 7 days) | Engineering lead | Tell affected players they can `claim_timeout` once it passes, or `cancel_match` together now. |
| Any time | Nobody | Submit or override a result that the platform did not report. |

Re-enqueuing is a manual step today; there is no command for it yet. Each DLQ entry (`listDlqEntries` in `apps/backend/src/queue.ts`) keeps the polling job with its match ID, game ID, platform and username, which is everything needed to create a new polling job for the match.

Before re-enqueuing, check the match on-chain with `get_match`. Skip any match that is already `Cancelled` (a player claimed the timeout or both cancelled) or already has a result.

## Participant communication

Post a notice on the status page and in the app banner when an outage is confirmed, and update it when it ends.

> **{Lichess / Chess.com} is unavailable.** We can't read game results from {platform} right now, so matches played there are waiting to settle. Your stake is safe in the escrow contract. Results will settle automatically once {platform} is back. No result is ever recorded without the platform's confirmation. If a match is still unsettled after {timeout, about 7 days} from when it started, either player can reclaim both stakes with "Claim timeout", or both players can cancel the match now to get stakes back immediately.

Every notice must say:

- which platform is affected, and since when;
- that stakes are held in the contract and nothing has been settled from missing data;
- the two remedies, `claim_timeout` after the timeout and a mutual `cancel_match` at any time.

## Tests

`apps/backend/tests/provider-outage.test.ts` checks that, for every outage signal above, the poller never reports a completed game and the polling worker never calls the result-submission handler, including when the attempt budget runs out.
