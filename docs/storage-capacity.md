# Storage Capacity and Disk-Pressure Alarms

The oracle keeps its durable state in SQLite files on the backend's runtime volume:

| File | Contents |
|---|---|
| `oracle-queue.db` | Pending result submissions (`oracle_dlq`) |
| `match-store.db` | Match records |
| rate-limit and circuit-breaker databases | Short-lived counters |

If that volume fills up, SQLite writes fail and settlement processing stops. This page covers how usage is measured, the limits, the alarms, and how to free space safely (#105).

## What is measured

Every `STORAGE_CHECK_INTERVAL_MS` (default 5 minutes), the backend measures every `*.db` file in the queue database's directory, together with its `-wal` and `-shm` companions. It also measures the free space on that volume. `apps/backend/src/store/storage-capacity.ts` does the work; `maintenance.ts` starts it at boot.

Each run logs one line, which can be scraped as a metric:

```json
{"metric":"storage_capacity","level":"ok","total_bytes":7340032,"capacity_bytes":1073741824,"used_ratio":0.0068,"volume_free_bytes":41231686041,"reasons":[]}
```

## Limits and alarms

| Setting | Default | Meaning |
|---|---|---|
| `STORAGE_CAPACITY_BYTES` | 1 GiB | Budget for all databases together. Set it below the volume size, leaving room for VACUUM (see below). |
| `STORAGE_WARN_RATIO` | 0.8 | `storage_capacity_warning` at 80% of the budget |
| `STORAGE_CRITICAL_RATIO` | 0.95 | `storage_capacity_critical` at 95% of the budget |
| `STORAGE_MIN_FREE_BYTES` | 512 MiB | `storage_capacity_critical` when the volume has less free space than this, whatever the budget says |
| `STORAGE_CHECK_INTERVAL_MS` | 300000 | How often to check |

Invalid values fall back to the defaults. The critical ratio is always kept above the warning ratio.

**Alert on the log lines.** Page on `storage_capacity_critical`, and open a ticket on `storage_capacity_warning`. The two thresholds sit well before the volume is actually full, so there is time to act.

## Responding to an alarm

1. **Find what grew.** Check `total_bytes` and the per-file sizes on the host (`ls -lh apps/backend/data`).
2. **Reclaim space.** Compact the largest database during a quiet period:
   ```ts
   import { reclaimSpace } from './store/storage-capacity.js';
   await reclaimSpace('data/oracle-queue.db'); // { before, after } in bytes
   ```
   This truncates the WAL and runs `VACUUM`. It **never deletes rows**, so pending settlements are untouched; `tests/store/storage-capacity.test.ts` checks exactly that. VACUUM temporarily needs free space up to the database's size, which is why the budget should leave headroom.
3. **If it's still critical,** grow the volume. Do not delete database files or rows to make room. The only rows removed automatically are dead-letter entries older than `DLQ_TTL_DAYS` (default 7), whose matches can already be reclaimed on-chain with `claim_timeout`. That is a retention policy, not a capacity measure.
4. **Record it.** If the alarm was critical, record it in the post-incident report.
