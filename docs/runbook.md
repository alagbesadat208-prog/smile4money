# Operational Runbook — smile4money

> **Audience:** On-call engineers and administrators with access to the admin private key.
> **Scope:** Emergency response, oracle key rotation, and post-incident analysis.

---

## Table of Contents

1. [Emergency Contract Pause](#1-emergency-contract-pause)
2. [Oracle Signing Key Rotation](#2-oracle-signing-key-rotation)
3. [Oracle Key Compromise Response](#3-oracle-key-compromise-response)
4. [Emergency Fund Drain](#4-emergency-fund-drain)
5. [Unpausing the Contract](#5-unpausing-the-contract)
6. [Post-Incident Report Template](#6-post-incident-report-template)
7. [Contact Escalation List](#7-contact-escalation-list)
8. [Production Readiness Gates](#8-production-readiness-gates)

---

## 1. Emergency Contract Pause

**When to use:** Suspected exploit, incorrect payout, oracle compromise, or any situation where
halting new activity is safer than continuing operations.

**Who can pause:** Only the `admin` address set during `initialize`.

**Effect:** Blocks `create_match`, `deposit`, and `submit_result`. `cancel_match` remains
available so players can always recover their funds.

### Steps

#### 1.1 Confirm the admin identity

```bash
# Verify your local key matches the on-chain admin
stellar keys address admin-key
# Compare output against the CONTRACT_ADMIN value in your .env
```

#### 1.2 Pause the escrow contract

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network testnet \
  -- pause
```

For **mainnet**, replace `--network testnet` with `--network mainnet`.

#### 1.3 Verify the pause is in effect

```bash
# This call should return an error: Error::ContractPaused (code 9)
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source any-key \
  --network testnet \
  -- create_match \
  --player1 GDUMMY1 \
  --player2 GDUMMY2 \
  --stake_amount 1 \
  --token GDUMMY3 \
  --game_id test \
  --platform '{"Lichess":{}}'
# Expected output: error code 9 (ContractPaused)
```

Alternatively, query the `Paused` instance storage key using Stellar's RPC:

```bash
curl -s "https://soroban-testnet.stellar.org" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,
    "method":"getLedgerEntries",
    "params":{"keys":["<PAUSED_LEDGER_KEY_XDR>"]}
  }'
```

#### 1.4 Notify the team

Post to the incident channel immediately:

```
[INCIDENT] Escrow contract PAUSED at ledger <N> by <admin-address>.
Reason: <brief description>
Next action: <investigation / drain / oracle rotation>
```

---

## 2. Oracle Signing Key Rotation

**When to use:** Oracle private key is compromised, exposed in logs, or as a scheduled rotation.

**Who can rotate:** Only the `admin` address.

### Steps

#### 2.1 Generate a new oracle keypair

```bash
stellar keys generate new-oracle-key --network testnet
stellar keys address new-oracle-key
# Save the output address as NEW_ORACLE_ADDRESS
```

For mainnet, **generate the keypair offline** on an air-gapped machine and import the public
address only:

```bash
# On air-gapped machine
stellar keys generate new-oracle-key
stellar keys address new-oracle-key   # copy this address

# On connected machine — fund the new account
stellar account fund --address <NEW_ORACLE_ADDRESS> --network testnet
```

#### 2.2 Fund the new oracle account (testnet)

```bash
stellar account fund --address "$NEW_ORACLE_ADDRESS" --network testnet
```

#### 2.3 Call `update_oracle` on the escrow contract

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network testnet \
  -- update_oracle \
  --new_oracle "$NEW_ORACLE_ADDRESS"
```

#### 2.4 Call `transfer_admin` on the oracle contract

The oracle **contract** also has its own admin (the off-chain service key). Rotate it too:

```bash
stellar contract invoke \
  --id "$CONTRACT_ORACLE" \
  --source old-oracle-key \
  --network testnet \
  -- transfer_admin \
  --new_admin "$NEW_ORACLE_ADDRESS"
```

#### 2.5 Verify the new oracle is registered

```bash
# Submit a test result with the new key (use a safe test match_id on testnet)
stellar contract invoke \
  --id "$CONTRACT_ORACLE" \
  --source new-oracle-key \
  --network testnet \
  -- submit_result \
  --match_id 0 \
  --game_id "rotation-verify-test" \
  --result '{"Player1Wins":{}}'
```

Expected: success (or `AlreadySubmitted` if a result already exists — both confirm auth works).

#### 2.6 Update the oracle service configuration

```bash
# In the oracle service deployment (e.g., systemd, Docker, or cloud secret store):
# Replace ORACLE_SIGNING_KEY with the new key
# Restart the oracle service and confirm it re-connects successfully
systemctl restart smile4money-oracle   # or equivalent
journalctl -u smile4money-oracle -f    # watch for errors
```

#### 2.7 Revoke and destroy the old key

- Remove the old key from all `.env` files and secret stores.
- If using a hardware wallet, revoke the signing slot.
- Document the rotation in the incident log.

---

## 3. Oracle Key Compromise Response

**When to use:** You have confirmed or strongly suspect the oracle signing key has been leaked,
stolen, or otherwise compromised (e.g. key found in logs, repo, or environment variable leak).

> ⚠️ **Treat this as a Critical incident.** A compromised oracle key means an attacker can
> fabricate match results and drain escrow funds for any active match.

**Who can respond:** Admin keyholder (for pause and `update_oracle`), oracle service owner (for
auditing events and key destruction).

### Steps

#### 3.1 Pause the escrow contract immediately

Do this **first**, before any investigation. Every second the contract is unpaused, an attacker
with the oracle key can call `submit_result` and steal funds.

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network testnet \
  -- pause
```

Verify the pause is in effect (see [§1.3](#13-verify-the-pause-is-in-effect)).

Post to the incident channel:

```
[CRITICAL INCIDENT] Oracle key suspected compromised. Escrow PAUSED at ledger <N>.
Auditing submit_result events. Do NOT unpause until new oracle key is confirmed.
```

#### 3.2 Call `update_oracle` with a new safe address

Generate a fresh oracle keypair on a clean machine (air-gapped for mainnet):

```bash
# Generate new keypair
stellar keys generate new-oracle-key --network testnet
stellar keys address new-oracle-key
# Save the output as NEW_ORACLE_ADDRESS
```

Register the new key on the escrow contract:

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network testnet \
  -- update_oracle \
  --new_oracle "$NEW_ORACLE_ADDRESS"
```

Also rotate the oracle contract's own admin (see [§2.4](#24-call-transfer_admin-on-the-oracle-contract)).

The old key is now rejected by the escrow contract even if the attacker still holds it.

#### 3.3 Audit all `submit_result` events since the compromise date

Identify the earliest ledger at which the key could have been compromised, then query all
`submit_result` events from that ledger forward:

```bash
# Query the Stellar RPC for contract events emitted by the escrow contract
curl -s "https://soroban-testnet.stellar.org" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getEvents",
    "params": {
      "startLedger": <COMPROMISE_LEDGER>,
      "filters": [{
        "type": "contract",
        "contractIds": ["'"$CONTRACT_ESCROW"'"],
        "topics": [["*", "result"]]
      }]
    }
  }'
```

For each event, cross-reference with:
- The actual match outcome on Lichess/Chess.com using the `game_id`
- The on-chain payout destination

Flag any result where the recorded winner does not match the actual game outcome.

#### 3.4 For fraudulent results, call `override_result` during the dispute window

If any `submit_result` calls were fraudulent, override them before the dispute window expires:

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network testnet \
  -- override_result \
  --match_id "$AFFECTED_MATCH_ID" \
  --correct_winner '{"Player1Wins":{}}' \
  --caller "$ADMIN_ADDRESS"
```

> ⚠️ **Time-sensitive:** `override_result` is only valid within the dispute window
> (`claim_timeout` ledgers after `submit_result` was called). Check the `pending_result_ledger`
> field on the affected match and act promptly.

Repeat for each fraudulent match result identified in §3.3.

#### 3.5 Unpause the contract

Only unpause after:

- [ ] New oracle key is registered and the oracle service is running with it
- [ ] All fraudulent results have been overridden
- [ ] All affected players have been notified and refunds confirmed where applicable
- [ ] A second team member has reviewed the audit findings

See [§5 Unpausing the Contract](#5-unpausing-the-contract) for the unpause command and checklist.

#### 3.6 Destroy and revoke the old key

- Delete the key from all `.env` files, CI secrets, and cloud secret stores
- If using a hardware wallet, revoke the compromised signing slot
- Document the compromise in the incident log and open a post-incident report (see §6)

---

## 4. Emergency Fund Drain

**When to use:** Active exploit with no time for match-by-match resolution. Transfers the
entire contract token balance to a safe cold-wallet address.

> ⚠️ **This is irreversible.** All in-progress matches will lose their escrowed funds.
> Use only when the alternative is losing more funds to an exploit.

### Prerequisites

- Contract must be **paused** (see §1).
- A **safe cold-wallet address** (`SAFE_ADDRESS`) that is NOT the admin hot wallet.

### Steps

#### 4.1 Confirm the contract is paused (see §1.3)

#### 4.2 Execute the drain

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network testnet \
  -- emergency_drain \
  --to "$SAFE_ADDRESS" \
  --caller "$ADMIN_ADDRESS"
```

#### 4.3 Confirm balance is zero

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source any-key \
  --network testnet \
  -- get_escrow_balance \
  --match_id 0
# Should return 0 for all match IDs
```

Check the contract's raw token balance:

```bash
stellar contract invoke \
  --id "$TOKEN_ADDRESS" \
  --source any-key \
  --network testnet \
  -- balance \
  --id "$CONTRACT_ESCROW"
# Expected: 0
```

#### 4.4 Record the drain transaction hash and notify all stakeholders

---

## 5. Unpausing the Contract

Only unpause after the incident is fully resolved and the root cause has been addressed.

### Checklist before unpausing

- [ ] Root cause identified and fixed (contract upgrade or oracle key rotated)
- [ ] All affected matches manually reconciled (refunds issued if needed)
- [ ] At least one other team member has reviewed and signed off
- [ ] Incident report drafted (see §5)

### Command

```bash
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source admin-key \
  --network testnet \
  -- unpause
```

### Verify

```bash
# Should succeed and return a match_id
stellar contract invoke \
  --id "$CONTRACT_ESCROW" \
  --source player1-key \
  --network testnet \
  -- create_match \
  --player1 "$PLAYER1_ADDRESS" \
  --player2 "$PLAYER2_ADDRESS" \
  --stake_amount 10000000 \
  --token "$TOKEN_ADDRESS" \
  --game_id "post-incident-verify" \
  --platform '{"Lichess":{}}'
```

---

## 6. Post-Incident Report Template

Copy this template and fill it in for every incident, regardless of severity.

---

### Incident Report — [YYYY-MM-DD] [Brief Title]

**Severity:** Critical / High / Medium / Low
**Status:** Open / Resolved
**Report Author:** [Name / GitHub handle]
**Reviewed by:** [Name / GitHub handle]

#### Timeline

| Time (UTC) | Event |
|------------|-------|
| HH:MM | Incident detected (how: alert / user report / monitoring) |
| HH:MM | On-call engineer paged |
| HH:MM | Contract paused at ledger N (tx hash: `...`) |
| HH:MM | Root cause identified |
| HH:MM | Fix deployed / oracle rotated |
| HH:MM | Contract unpaused at ledger N (tx hash: `...`) |
| HH:MM | Incident resolved |

#### Impact

- **Users affected:** [number / description]
- **Funds at risk:** [amount in XLM/USDC]
- **Funds lost:** [amount, or "none"]
- **Matches disrupted:** [match IDs]
- **Duration of outage:** [HH:MM]

#### Root Cause

[One paragraph describing what went wrong, why it happened, and what allowed it to occur.]

#### What Went Well

- [Item 1]
- [Item 2]

#### What Went Poorly

- [Item 1]
- [Item 2]

#### Remediation

| Action | Owner | Due Date | Status |
|--------|-------|----------|--------|
| [Fix description] | [Name] | YYYY-MM-DD | Open |
| [Monitoring improvement] | [Name] | YYYY-MM-DD | Open |
| [Runbook update] | [Name] | YYYY-MM-DD | Open |

#### Sign-off

- [ ] Incident lead reviewed
- [ ] Second team member reviewed
- [ ] Remediation items tracked in GitHub Issues

---

## 7. Contact Escalation List

> Replace placeholder entries with real contact information before deploying to mainnet.

| Role | Contact | How to reach |
|------|---------|--------------|
| On-call engineer (primary) | [Name] | PagerDuty / Signal |
| On-call engineer (backup) | [Name] | PagerDuty / Signal |
| Contract admin keyholder | [Name] | End-to-end encrypted message only |
| Oracle service owner | [Name] | Slack `#oracle-ops` |
| Stellar network status | SDF | https://status.stellar.org |
| Lichess API status | Lichess | https://lichess.org/status |
| Chess.com API status | Chess.com | https://www.chess.com/news |

### Escalation path

1. On-call primary — immediate (0–15 min)
2. On-call backup — if primary unreachable (15–30 min)
3. Contract admin keyholder — required for pause/drain/oracle rotation
4. All team leads — severity Critical only

---

## 8. Production Readiness Gates

> **When:** before the first mainnet wagering launch, and before every later mainnet release that
> changes a contract, the oracle service, or a version in [compatibility.md](compatibility.md).
> **Rule:** launch is **GO** only when every gate below is recorded **PASS**, or **WAIVED** where a
> waiver is allowed, in a release review record. The `Deploy to Mainnet` workflow checks the record
> and refuses to start without it (see [§8.4](#84-release-review-record)).

A checklist of tasks says what was done. These gates say whether it was done *well enough to
take real money*. Every threshold is a number someone can measure and someone owns.

### 8.1 Gates

Measurements come from the **testnet soak**: the release candidate running unchanged on testnet
for at least 14 consecutive days, the frontend and backend pointed at it, with real Lichess and
Chess.com games. Logs and traces (`trace_id`, see [infrastructure.md §8.1](infrastructure.md#81-trace-context-propagation))
are the primary evidence.

| Gate | Area | GO threshold (all must hold) | How it is measured | Evidence owner | Waivable |
|---|---|---|---|---|---|
| **G1** | Settlement correctness | ≥ 200 matches settled end to end during the soak, at least 50 from each provider and at least 20 draws. **0** settlements that disagree with the provider's result. **0** double payouts. **0** settlements from a `ProviderSchemaError` payload. | A reconciliation of every soak match (match id → provider result → `submit_result` tx → payout tx). The provider fixture suite (`tests/fetchers/provider-fixtures.test.ts`) is green. | Oracle service owner | No |
| **G2** | Settlement latency | From game end to a confirmed `submit_result`: **p95 ≤ 10 min**, **p99 ≤ 60 min**, **max ≤ 24 h**. Every match settles inside `DISPUTE_WINDOW_LEDGERS` + `TIMEOUT_LEDGERS`, so no player needs `claim_timeout` because the oracle was late. | `game_completed` → `submit_result` confirmation timestamps from the logs, joined on `trace_id`, over all soak matches. | Oracle service owner | No |
| **G3** | Queued-work recovery | DLQ depth **0** at the end of the soak. Every DLQ entry written during the soak resolved within **24 h**. **0** entries removed by TTL eviction. Alerts fire within **5 min** for: oracle `/health` down, DLQ depth > 0 for 1 h, and a G2 p95 breach over 1 h. | `oracle_dlq_depth` metric history, `oracle_dlq:` log lines, and an alert test (stop the oracle on testnet, confirm the page arrives). | Oracle service owner | No |
| **G4** | Incident recovery | Drills run on testnet within the last **30 days**, timed from page to verified outcome: emergency pause ([§1](#1-emergency-contract-pause)) **≤ 15 min**; oracle key rotation ([§2](#2-oracle-signing-key-rotation)) **≤ 60 min**; rollback rehearsal ([deployment.md](deployment.md#testnet-rollback-rehearsal)) **≤ 2 h**. | A drill log with UTC timestamps and tx hashes for each step. | On-call engineer (primary) | No |
| **G5** | Data durability | DLQ SQLite store on a persistent volume, backed up at least every **15 min** (RPO ≤ 15 min). A restore from backup was tested in the last **30 days** and completed in **≤ 1 h** (RTO). The service restarted with no DLQ entries lost. | Backup schedule config, a restore drill log, and the DLQ entry count before and after the restart. | Backend owner | Yes, ≤ 14 days |
| **G6** | Capacity | At **3×** the launch plan's expected peak of concurrently active matches (minimum **500** polling jobs), sustained for **1 h**: API **p95 ≤ 500 ms**, **5xx < 0.5 %**, each polling cycle finishes inside `POLLING_INTERVAL_MS`, provider **429s < 1 %** of calls, and Stellar RPC errors **< 1 %**. | A load test report against testnet, with the job count, latency histogram and error counts. | Backend owner | Yes, ≤ 14 days |
| **G7** | Build, security and compatibility | The release commit has every CI job green, including the **Compatibility Matrix** job. `cargo audit` reports **0** unresolved advisories. The latest scheduled **Compatibility** run shows no new failure in a *required* row ([compatibility.md](compatibility.md)). The deployed WASM hash equals the CI artifact hash ([deployment.md](deployment.md#verify-deployment--wasm-hash-check)). | Links to the CI run, the audit output, the compatibility run, and the hash comparison. | Release manager | No |
| **G8** | User support | Support channel staffed, with first response **≤ 4 h** during announced support hours and **≤ 24 h** otherwise. A dry run of **10** scripted tickets (stuck match, wrong result claim, how to dispute, how to `claim_timeout`, lost-deposit scare, …) is **10/10** answered correctly within target. A user-facing guide for disputes and `claim_timeout` is published. [§7](#7-contact-escalation-list) has **no** `[Name]` placeholders left. A status page and the incident notice template ([deployment.md](deployment.md#1-declare-the-incident-and-freeze-writes)) are ready. | The dry-run ticket log with timestamps, links to the guide and status page, and the filled-in §7. | Support lead | Yes, ≤ 14 days |

A gate with no evidence linked is a **FAIL**, not a PASS.

### 8.2 Waivers

Only gates marked *Waivable* can be waived, and only when **two** people approve it in the release
review: the release manager **and** the contract admin keyholder. A waiver records the reason,
the mitigation in place, and an expiry no more than 14 days after launch. If the gate still isn't
PASS on the expiry date, that triggers a rollback decision (§8.3). Settlement gates (G1–G4) and
G7 can never be waived.

### 8.3 Rollback authority

**Before launch.** The release review decides GO or NO-GO. The release manager chairs it but
**cannot** overrule a FAIL. Any evidence owner may call NO-GO for their own gate.

**During the 30-day launch watch** (and for any later release, the 7 days after it):

| Trigger (any one) | Who may act without asking | What they do |
|---|---|---|
| A settlement disagrees with the provider's result, or a double payout | On-call engineer (primary or backup) | Pause immediately ([§1](#1-emergency-contract-pause)), then page the keyholder |
| Settlement p95 > 30 min for 2 consecutive hours, or any DLQ entry older than 24 h | On-call engineer | Stop accepting new matches (frontend/oracle writes); page the oracle service owner |
| Oracle unavailable > 30 min with active matches | On-call engineer | Pause ([§1](#1-emergency-contract-pause)) |
| A waiver expires with its gate not PASS | Release manager | Calls the rollback decision meeting within 24 h |

**Rolling back** a release ([deployment.md → Rollback Procedure](deployment.md#rollback-procedure-mainnet))
needs the **contract admin keyholder** to execute it and the **oracle service owner** to agree.
Either of them can start it. If the two disagree, the contract stays **paused** until they agree,
because pausing is always safe and a rollback is not reversible. Unpausing after any trigger
follows [§5](#5-unpausing-the-contract), and the same two people sign it off.

### 8.4 Release review record

Each mainnet release has a record at `docs/release-reviews/<release>.md`, where `<release>` is the
tag being deployed, such as `v1.0.0`. Copy it from
[`docs/release-reviews/TEMPLATE.md`](release-reviews/TEMPLATE.md). For every gate it records:

- the measured value
- PASS, FAIL or WAIVED
- an evidence link
- the evidence owner's name

It also records the decision and both sign-offs.

`python scripts/check_release_review.py docs/release-reviews/<release>.md` validates the record.
It fails when:

- a gate is missing, or has no evidence or no owner
- a non-waivable gate is waived, or a waiver lacks both approvals or an expiry
- the decision is GO while any gate is FAIL

`Deploy to Mainnet` runs this check first. A tag push checks the record named after the tag; a
manual run asks for the record's path. Merge the record (and so the decision) before deploying.

---

*This runbook is a living document. Update it whenever a procedure changes or a gap is discovered
during an incident. The reviewing engineer is responsible for merging updates.*
