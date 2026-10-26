/**
 * Runtime maintenance wiring: storage capacity alarms (#105) and the live
 * database restore trigger (#108). Installed once by server.ts.
 *
 * Live restore is triggered from the host, never over HTTP: write
 * `{"backupPath": "/path/to/backup.db"}` to `restore-request.json` next to
 * the queue database, then send SIGUSR2 to the backend process. The result
 * is written to `restore-result.json` in the same directory. Only someone
 * with shell access to the host can do both. See docs/live-restore.md.
 */
import fs from 'fs';
import path from 'path';
import { getMaintainableQueueStore } from './queue.js';
import { performLiveRestore, defaultRestoreRequestPath } from './store/live-restore.js';
import type { DlqEntry } from './store/persistent-queue-store.js';
import { startStorageCapacityMonitor, type CapacityLogger } from './store/storage-capacity.js';

export interface MaintenanceOptions {
  logger: CapacityLogger;
  /** On-chain check used to drop restored entries that were already settled. */
  isSettled?: (entry: DlqEntry) => Promise<boolean>;
  /** Signal that triggers a restore. Default SIGUSR2. */
  signal?: NodeJS.Signals;
}

/** All SQLite databases in the queue database's directory. */
export function listDatabases(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Handle one restore request. Exported for tests; the signal handler calls it.
 * Returns the result object that is also written to `restore-result.json`.
 */
export async function handleRestoreRequest(
  options: MaintenanceOptions,
): Promise<Record<string, unknown>> {
  const store = getMaintainableQueueStore();
  const databasePath = store?.databasePath();
  if (!store || !databasePath) {
    return { ok: false, error: 'no file-backed queue store is active' };
  }
  const requestPath = defaultRestoreRequestPath(databasePath);
  const resultPath = path.join(path.dirname(databasePath), 'restore-result.json');
  let result: Record<string, unknown>;
  try {
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8')) as { backupPath?: unknown };
    if (typeof request.backupPath !== 'string' || request.backupPath === '') {
      throw new Error('restore-request.json must contain a "backupPath" string');
    }
    const report = await performLiveRestore({
      store,
      backupPath: request.backupPath,
      databasePath,
      isSettled: options.isSettled,
      log: (event, fields) => options.logger.info({ ...fields }, event),
    });
    result = { ok: true, ...report };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    options.logger.error(result, 'live_restore_failed');
  }
  fs.rmSync(requestPath, { force: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** Start the capacity monitor and register the restore signal. Returns a stop function. */
export function installMaintenance(options: MaintenanceOptions): () => void {
  const store = getMaintainableQueueStore();
  const databasePath = store?.databasePath();
  const stopMonitor = databasePath
    ? startStorageCapacityMonitor(listDatabases(path.dirname(databasePath)), options.logger)
    : () => {};

  const signal = options.signal ?? 'SIGUSR2';
  let running = false;
  const onSignal = () => {
    if (running) {
      options.logger.warn({}, 'live_restore_already_running');
      return;
    }
    running = true;
    void handleRestoreRequest(options).finally(() => {
      running = false;
    });
  };
  process.on(signal, onSignal);

  return () => {
    stopMonitor();
    process.off(signal, onSignal);
  };
}
