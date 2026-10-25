# Chess-provider payload fixtures

Deterministic, privacy-safe response bodies for the Lichess and Chess.com
parsers (issue #121). `tests/fetchers/provider-fixtures.test.ts` feeds each
file to the real parser through a mocked `axios`, so the suite never touches
the network.

| Directory | Endpoint the body stands in for |
|---|---|
| `lichess/` | `GET https://lichess.org/api/game/{id}` (JSON) |
| `chessdotcom/` | `GET https://api.chess.com/pub/player/{user}/games/{yyyy}/{mm}` |

## Cases

Each file name starts with the case it covers:

- `decisive-*`: a game with a winner. Must map to `Player1Wins` (white) or `Player2Wins` (black).
- `draw-*`: finished with no winner. Must map to `Draw`.
- `ongoing-*`: still being played. Must map to `null`, so the match is not settled.
- `malformed-*`: a required field is missing or has the wrong type. Must throw `ProviderSchemaError`.
- `changed-schema-additive`: the provider added fields. Must still parse to the same result.
- `changed-schema-renamed-*` / `changed-schema-unknown-code`: the provider renamed or
  replaced something the mapping depends on. Must throw `ProviderSchemaError`,
  never settle a wager on a guess.

Chess.com bodies are whole monthly archives, so a single file can hold several
games. The test names the game id it looks up in each one.

## Sanitisation rules

These files are committed, so they must never contain real user data:

- Usernames are `fixture-white` / `fixture-black`; game ids are synthetic
  (`fxLi0001…`, `1000000xx`); UUIDs use the all-zero `00000000-0000-4000-8000-…` form.
- No emails, tokens, API keys, IP addresses, or real profile URLs beyond the
  provider's public URL pattern built from a fixture username.
- Timestamps are fixed (2026-01-01), not "now".

`provider-fixtures.test.ts` checks these rules on every file, so a fixture
pasted from a live response fails CI until it is scrubbed.

## Adding a fixture

1. Capture the response, then replace every username, id, UUID and timestamp as above.
2. Name it `<case>-<detail>.json` in the right directory.
3. Add its expected outcome to the table in `provider-fixtures.test.ts`.
   The test fails if a fixture file has no expectation.
