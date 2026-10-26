# Supported Games

Read this before you stake. A wager can only be settled if the oracle can read the game from the chess platform and get a result it can verify. Games outside these rules are rejected when the game is validated, before any funds move.

## The rules

| Rule | Supported | Not supported |
|---|---|---|
| Platform | Lichess, Chess.com | Any other site, over-the-board games |
| Variant | Standard chess | Chess960, custom starting positions (Lichess "From Position"), Crazyhouse, Atomic, King of the Hill and every other variant |
| Time control | Bullet, blitz, rapid, classical, with a clock | Correspondence (Lichess), daily (Chess.com), unlimited / no clock |
| Visibility | Public games the platform API can return | Private, unlisted-and-unreachable or deleted games |
| Players | The two players named in the match | A game between other accounts |
| Completion | A game in progress, or a game that ended with a result | Aborted games, games that never started, games with an unknown finish |

Rated and casual games are both accepted.

### Why correspondence and daily games are excluded

A match that never gets a result can be reclaimed on-chain with `claim_timeout` once its timeout passes (about 7 days by default). Correspondence and daily games routinely last longer than that, so the wager could time out and refund while the game is still being played.

### Which endings count

- **Win**: checkmate, resignation, flag fall (timeout), or a player being flagged for cheating. The other player wins.
- **Draw**: agreement, stalemate, repetition, insufficient material, the 50-move rule, timeout against insufficient material.
- **No result**: the game was aborted, never started, or ended in a way the platform reports as unknown. There is nothing to settle. Get your stake back by cancelling the match together (`cancel_match`) or with `claim_timeout` after the timeout.

## How the rules are enforced

The validation endpoint (`POST /api/validate-game`) checks each rule it can read from the platform. A game that exists but breaks a rule gets HTTP `422`, with every broken rule listed:

```json
{
  "valid": false,
  "platform": "lichess",
  "gameId": "abcd1234",
  "message": "Variant \"chess960\" is not supported; only standard chess can be wagered on.",
  "rejections": [
    {
      "code": "UNSUPPORTED_VARIANT",
      "message": "Variant \"chess960\" is not supported; only standard chess can be wagered on."
    }
  ],
  "error": { "code": "VALIDATION_ERROR", "message": "..." }
}
```

| Code | Meaning |
|---|---|
| `UNSUPPORTED_VARIANT` | The game is not standard chess. |
| `UNSUPPORTED_TIME_CONTROL` | The game is correspondence, daily or unlimited. |
| `NO_CLOCK` | The game has no clock. |
| `UNVERIFIABLE_COMPLETION` | The game ended without a verifiable result. |

A private or deleted game cannot be fetched at all and gets `404` (`NOT_FOUND`) instead.

The rules live in `apps/backend/src/services/game-eligibility.ts` and are covered by `apps/backend/tests/services/game-eligibility.test.ts`. Change this page, the module and its tests together.

### What is checked today

- **Completion** is checked for every game, from the status the fetcher returns.
- **Variant, time control and clock** are checked whenever the fetcher attaches `metadata` to the game it returns. `lichessMetadata` and `chessDotComMetadata` in the same module read those fields from the raw provider payloads.
- **Players** are checked by the oracle before it submits a result: `verifyPlayerIdentities` (`apps/backend/src/services/player-identity.ts`) requires the game's two usernames to be the match's registered players, in either colour. This endpoint does not check them.
