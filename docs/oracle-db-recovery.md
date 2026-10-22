# Oracle Database Recovery

How the oracle's durable data is backed up, how much can be lost, how long recovery takes, and how to restore. The restore is rehearsed automatically by `apps/backend/tests/store/sqlite-backup-restore.test.ts` on every CI run.

## What is protected

| Database | Default path | Contents | Why it matters |
|---|---|---|---|
| `oracle-queue.db` | `apps/backend/data/oracle-queue.db` | `oracle_dlq`: result submissions that failed and are waiting to be retried | Each row is a **pending settlement**. Losing it means a finished game is never submitted, and the players must fall back to `claim_timeout`. |
| `match-store.db` | `apps/backend/data/match-store.db` | Match records: players, usernames, stake, game ID, platform | Needed to verify player identities before a result is submitted. |

The chain is the source of truth for funds and match state. These databases hold work in progress that the chain does not know about yet. That is exactly what a backup has to save.

Rate-limit and circuit-breaker databases hold short-lived counters that rebuild on their own. They are not backed up.

## Objectives

| Objective | Target | How it is met |
|---|---|---|
| **Backup frequency** | Every hour, plus before every deploy | Scheduled `db-backup backup` (below) |
| **Recovery point (RPO)** | At most **1 hour** of new entries lost | Hourly online snapshots |
| **Recovery time (RTO)** | Service accepting work again within **30 minutes** of the decision to restore | Restore is one command; the databases are small |
| **Retention** | **35 days**, and always at least the newest backup | `pruneBackups`, run after every backup |
| **Rehearsal** | Every CI run (automated), plus a manual drill each quarter | `sqlite-backup-restore.test.ts`; drill steps below |

**What a 1-hour RPO means in practice.** A settlement that entered the queue after the last backup is lost on restore. The match stays `Active` or `PendingResult` on-chain, so nothing is paid out wrongly. Operators re-submit the result once the oracle is back; see *After a restore* below. If the result can't be recovered, both players can reclaim their stakes with `claim_timeout` after the on-chain timeout (about 7 days).

## Taking backups

`apps/backend/src/cli/db-backup.ts` wraps `apps/backend/src/store/sqlite-backup.ts`:

```sh
cd apps/backend
# Snapshot, verify the snapshot, prune past 35 days. Exits non-zero on failure.
npx tsx src/cli/db-backup.ts backup data/oracle-queue.db /var/backups/oracle
npx tsx src/cli/db-backup.ts backup data/match-store.db  /var/backups/oracle
```

- **Safe while running.** Backups use SQLite's `VACUUM INTO`, which takes a consistent snapshot while the service keeps writing (WAL mode). Each backup is a single self-contained file.
- **Never overwrites.** Files are named `<database>.<UTC time>.db`, and an existing file is never overwritten.
- **Store off-host.** Keep backups off the host: copy the backup directory to object storage with server-side encryption after each run. The tables hold usernames and wallet addresses, so restrict access to operators.
- **Alert on failure.** Schedule both commands hourly (cron, a systemd timer, or the platform's scheduler) and alert when one exits non-zero.

Example crontab:

```cron
0 * * * * cd /srv/smile4money/apps/backend && npx tsx src/cli/db-backup.ts backup data/oracle-queue.db /var/backups/oracle
2 * * * * cd /srv/smile4money/apps/backend && npx tsx src/cli/db-backup.ts backup data/match-store.db /var/backups/oracle
```

## Restoring

1. **Stop the backend** so nothing writes during the restore.
2. **Pick the newest backup** taken before the incident, and check it:
   ```sh
   npx tsx src/cli/db-backup.ts verify /var/backups/oracle/oracle-queue.<time>.db
   ```
   It must report `"ok": true`. The `tables` field shows the row counts.
3. **Keep the damaged database**, if it exists, for the post-incident report:
   ```sh
   mv data/oracle-queue.db data/oracle-queue.db.broken
   ```
4. **Restore:**
   ```sh
   npx tsx src/cli/db-backup.ts restore /var/backups/oracle/oracle-queue.<time>.db data/oracle-queue.db
   ```
   The backup is verified again first; an unhealthy backup is refused and the target is not touched. The target's stale `-wal`/`-shm` files are removed, so they can't be replayed onto the restored data.
5. **Repeat for `match-store.db`** if it was affected.
6. **Start the backend** and confirm the retry worker picks up the restored DLQ entries (`oracle_dlq: retrying oracle submission` in the logs).

### After a restore

- Anything written after the backup is gone.
- For each match with a finished game but no on-chain result, check it with `get_match` and re-submit through the normal oracle flow.
- Record the backup used, the RPO actually lost, and the time to recover in the post-incident report ([runbook §6](runbook.md#6-post-incident-report-template)).

## Quarterly drill

1. Copy the latest production backup to a staging host.
2. Run steps 2–6 of *Restoring* there, and time them against the 30-minute RTO.
3. Compare the restored `oracle_dlq` count with the count in the backup's `verify` output.
4. Record the result and any problems in the operations log.
