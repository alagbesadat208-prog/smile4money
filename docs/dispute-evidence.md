# Dispute evidence

**Status:** Active · issue #116

When a player disputes a settlement ("I won but was paid as a loss", "the match never settled",
"I was paid twice"), support collects the same set of references every time, from the same
sources, and nothing more. This page defines that **evidence bundle** and how to retrieve it.

## What the bundle contains

`npm run evidence` (in `apps/backend`) produces one JSON document per match
(`bundleVersion: 1`, built by `apps/backend/src/services/dispute-evidence.ts`):

| Section | Fields | Why support needs it |
|---|---|---|
| `match` | `matchId`, `gameId`, `platform`, `state`, `stakeAmount`, `token`, `player1`, `player2`, `identityHash` | What was wagered, by which wallets, on which game |
| `provider` | `gameUrl`; `lookup`: `gameStatus`, `result`, `playersMatchRecord` (or the lookup `error`, or `skipped`) | What Lichess / Chess.com reports **now**, and whether its players are still the ones recorded |
| `oracle.dlqEntries` | per entry for this match: `id`, `failureReason`, `attempts`, `createdAt`, `lastAttemptAt`, `traceparent`, `payloadResult` | Whether, when and why the oracle failed to settle, and which result it was trying to submit |
| `ledger` | `network`, `escrowContractId`, `oracleContractId`, `resultRecordedOnChain` (`true` / `false` / `unknown`), `explorerUrls` | Where to verify on-chain what was actually recorded and paid |
| (top level) | `generatedAt`, `digest` (SHA-256 of the body) | Proves a copy attached to a ticket hasn't been edited |

## What it never contains

It is built from an explicit allow-list, never by copying records wholesale. It leaves out:

- **Signing secrets and credentials.** That means the oracle key, deployer and admin keys,
  `JWT_SECRET`, and the provider API tokens. As a last check, the builder scans the finished
  bundle and **refuses to export it** if it finds anything secret-shaped: a Stellar secret seed
  (`S…`), a JWT, a Lichess token, a PEM private key, or the value of any secret env var listed in
  `SECRET_ENV_VARS`. A secret could otherwise slip in through an error message stored as a DLQ
  `failureReason`.
- **Chess usernames.** Support compares players through `identityHash` and
  `provider.lookup.playersMatchRecord`, so it never needs the handles, which are often real names.
- **Anything about the person asking:** request bodies, JWTs, IPs, emails, browser data.

Wallet addresses *are* included. They are public on-chain, and they're the only way to line
the bundle up with ledger entries.

`apps/backend/tests/dispute-evidence.test.ts` covers this: unexpected fields and usernames don't
appear, and a seed in a failure reason blocks the export.

## Retrieval procedure

Only operators with shell access to the backend host (or a shell with its env and data volume) can
produce a bundle. There is deliberately **no HTTP endpoint**: the API authenticates wallets, not
staff, so an endpoint would let any player's token fetch another match's evidence.

1. **Get the references from the ticket:** the `gameId` (from the game link) and, if the player
   has it, the `matchId`. Never ask the player for a secret key or seed phrase. They are never
   needed.
2. **Export the bundle:**

   ```bash
   cd apps/backend
   npm run --silent evidence -- --game-id <gameId> --match-id <matchId> > evidence-<matchId>.json
   ```

   - Add `--offline` to skip the live provider lookup, for example while a provider is down.
   - The command exits 1 with `evidence: …` on stderr when the game is unknown, when the two
     references point at different matches, or when the bundle would contain a secret. **Do not**
     work around a secret refusal: report it as a security incident ([runbook §3](runbook.md#3-oracle-key-compromise-response)).
3. **Verify on-chain.** Open the `ledger.explorerUrls` and confirm what the escrow and oracle
   contracts actually recorded for `matchId`. The chain is the authority. The bundle is the index
   into it.
4. **Compare the three sources:**

   | Situation | Likely cause | Next step |
   |---|---|---|
   | Provider `result` ≠ the result recorded on-chain | Wrong result submitted | Within the dispute window: `override_result` ([runbook §3.4](runbook.md#34-for-fraudulent-results-call-override_result-during-the-dispute-window)) |
   | `playersMatchRecord: false` | The game shown isn't the one the match was created for | Escalate to the oracle service owner, and don't override |
   | `resultRecordedOnChain: false` with DLQ entries | Settlement stuck (see `failureReason`, `attempts`) | Follow [oracle.md → Settlement Boundaries](oracle.md#settlement-boundaries) |
   | Nothing on-chain, no DLQ entry, and the game is over | Polling never picked the match up | Escalate to the oracle service owner |
   | `resultRecordedOnChain: true` and it matches the provider | Settled correctly | Reply to the player with the explorer link |

5. **Attach the file and its `digest` to the ticket**, and keep the reply to the player to the
   explorer link and the outcome. Delete local copies when the ticket closes. The bundle is
   pseudonymous, but it still links wallets to games.

`traceparent` values (when present) find every log line for that settlement: filter logs on the
trace id they contain.
