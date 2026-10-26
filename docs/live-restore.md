# Restoring the Queue Database While the Worker Runs

Replacing `oracle-queue.db` under a running backend is unsafe without coordination:

- **Lost work:** a dead-letter write could land in the file that is about to be replaced and disappear.
- **Replayed work:** the retry worker could resubmit settlements that were resolved after the backup was taken.

This procedure quiesces queue access, validates the backup, reconciles active jobs and resumes, all without restarting the process (#108). If you can afford a restart, the stop-the-service procedure is simpler.

## How it works

`performLiveRestore` (`apps/backend/src/store/live-restore.ts`) runs these steps:

1. **Quiesce.** The queue store is wrapped in a maintenance gate (`store/maintenance-gate.ts`). The gate stops new reads and writes from starting; they wait rather than fail. It also waits for calls already running to finish. The polling and retry workers keep running but can't touch the database.
2. **Snapshot.** The live queue entries are recorded.
3. **Validate.** The backup must pass `PRAGMA integrity_check` and have an `oracle_dlq` table with every column the store uses. If it doesn't, the restore stops here and the live database is untouched.
4. **Swap.** The live file is copied aside as `oracle-queue.db.pre-restore-<epoch-ms>`. The backup is copied into place atomically, stale `-wal`/`-shm` files are removed, and the store is reopened.
5. **Reconcile.** Entries are handled as follows:
   - **Re-added:** live entries missing from the backup, because they were queued after it, so nothing is lost.
   - **Dropped:** restored entries that are no longer live, if the on-chain check confirms the result was already submitted, so nothing is replayed.
   - **Kept:** every other restored entry stays pending. The retry worker submits through `submitWithIdempotence`, which skips any entry whose result is already on-chain. Both that and the reconciliation step rely on `checkResultExistsOnChain` in `server.ts`, which is still a placeholder that returns `false`. Until it is implemented, restored entries are always kept and may be resubmitted; the contract accepts only one result per match.
6. **Resume.** The gate opens, and the calls that were waiting run against the restored database.

If anything fails after the swap, the pre-restore file is put back before resuming. The workers are never left held.

## Running it

From a shell on the backend host:

```sh
cd apps/backend/data
# 1. Say which backup to restore.
echo '{"backupPath": "/var/backups/oracle/oracle-queue.2026-10-22T14-00-00Z.db"}' > restore-request.json
# 2. Trigger the restore in the running process.
kill -USR2 "$(pgrep -f 'node.*server')"
# 3. Read the result (written when the restore finishes).
cat restore-result.json
```

A successful result looks like:

```json
{
  "ok": true,
  "databasePath": ".../oracle-queue.db",
  "preRestoreCopy": ".../oracle-queue.db.pre-restore-1792677600000",
  "restoredEntries": 12,
  "readded": ["1792677000123-ab12cd"],
  "droppedSettled": [],
  "keptUnconfirmed": ["1792670000456-ef34gh"]
}
```

- **On failure:** `"ok": false` with an `error` (for example `backup failed validation: oracle_dlq.attempts is missing`). The live database is unchanged.
- **Logs:** progress is logged as `live_restore_quiesced`, `live_restore_snapshot`, `live_restore_swapped`, `live_restore_reconciled` and `live_restore_resumed`.
- **Signal:** the restore runs only from a request file plus a signal, both of which need host access. It is never exposed over HTTP. A second signal while one restore is running is ignored.

## Afterwards

- Check the `readded` and `keptUnconfirmed` IDs against the retry worker's logs over the next cycle.
- Keep the `.pre-restore-*` file until the incident is closed, then delete it.
- Record the restore in the post-incident report.

`apps/backend/tests/store/live-restore.test.ts` rehearses this with the real SQLite store. It covers a worker write racing the restore, settled-entry reconciliation, a corrupt backup, a backup with the wrong schema, and rollback.
