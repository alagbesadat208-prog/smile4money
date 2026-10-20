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
8. [Provider and Chain Outcome Disagreement Alert](#8-provider-and-chain-outcome-disagreement-alert)

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

## 8. Provider and Chain Outcome Disagreement Alert

The outcome disagreement monitor (`apps/backend/src/services/outcome-disagreement-monitor.ts`) raises a **review signal** when settled match outcomes repeatedly disagree with independent evidence. A compromised reporter or an anomalous game provider can otherwise stay invisible until several matches have already settled wrongly.

> **The alert is review-only.** It never pauses, reverses, overrides or settles anything. It only writes a structured log line and calls an optional notification callback. Every action below is a human decision.

### How the signal works

For each settled match the monitor compares two sources that it does not control:

1. The outcome recorded **on-chain** (what the reporter actually submitted).
2. A fresh outcome fetched **by the monitor itself** from the chess platform (Lichess or Chess.com). This is the independent evidence. It is never taken from the reporter's submission.

The provider result is converted to Player 1's perspective before comparing, because Player 1 is not always the white player.

Each observation is classified as `agree`, `disagree` or `unverifiable`. An observation is `unverifiable` when the game is still in progress, no chain result exists yet, the provider or RPC call failed, or the players cannot be mapped to colors. Unverifiable observations are **never** counted as disagreement.

### Thresholds

The review signal is raised when, inside the sliding window, **all** of these hold:

| Setting | Environment variable | Default |
|---------|----------------------|---------|
| Window size (most recent observations) | `OUTCOME_DISAGREEMENT_WINDOW_SIZE` | 20 |
| Maximum observation age (hours) | `OUTCOME_DISAGREEMENT_MAX_AGE_HOURS` | 24 |
| Minimum decided observations (agree + disagree) | `OUTCOME_DISAGREEMENT_MIN_DECIDED` | 5 |
| Minimum disagreements | `OUTCOME_DISAGREEMENT_MIN_DISAGREEMENTS` | 3 |
| Minimum disagreement rate (0 to 1) | `OUTCOME_DISAGREEMENT_MIN_RATE` | 0.2 |

Invalid values fail loudly at startup. Tune these as real traffic data accumulates, and record any change in the post-incident report (section 6).

### Log events

| Log message | Level | Meaning |
|-------------|-------|---------|
| `outcome_disagreement_review_required` | error | Sustained disagreement. Start a manual review. |
| `outcome_disagreement_recovered` | info | The window no longer meets the thresholds. |
| `outcome_evidence_degraded` | warn | At least half of the window could not be verified. Treat as a blind spot. |
| `outcome_evidence_recovered` | info | Verification is working again. |

The review log line includes the counts per platform and `disagreeingMatchIds`, the most recent disagreeing matches to start from.

### Response procedure

1. **Do not pause or override automatically.** Acknowledge the alert and open an incident.
2. For each id in `disagreeingMatchIds`, look up the game on the chess platform yourself and compare it with the on-chain result. Use the event query in section 3.3 to read what was submitted on-chain.
3. Check player colors. Confirm which username was Player 1 and which side they played before deciding that a result is wrong.
4. Classify the cause:
   - **Provider anomaly** (one platform affected, reporter otherwise consistent): check the provider status pages listed in section 7 and hold further submissions for that platform until it is understood.
   - **Reporter compromise suspected** (disagreements across platforms, or results that match no game): treat it as an oracle key compromise and follow section 3. Pausing, key rotation and `override_result` are manual, admin-keyholder decisions made inside the dispute window.
   - **False positive** (for example a slow provider or a mapping problem): record the cause and adjust the thresholds if needed.
5. For `outcome_evidence_degraded`, check provider and Stellar RPC status first. A long outage can hide an attack, so review recent settlements by hand until verification recovers.
6. Escalate using the path in section 7 and complete the report in section 6.
---

*This runbook is a living document. Update it whenever a procedure changes or a gap is discovered
during an incident. The reviewing engineer is responsible for merging updates.*
