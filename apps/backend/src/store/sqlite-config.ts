import type sqlite3 from "sqlite3";

/** SQLite is supported on local storage in one backend process only. */
export function sqliteSettings(env = process.env): { busyTimeoutMs: number } {
  if ((env.SQLITE_CONCURRENCY_MODE ?? "single-process") !== "single-process") {
    throw new Error("SQLite requires SQLITE_CONCURRENCY_MODE=single-process");
  }
  for (const key of ["BACKEND_REPLICAS", "WEB_CONCURRENCY"]) {
    if (env[key] !== undefined && Number(env[key]) !== 1) {
      throw new Error(
        `SQLite requires ${key}=1; multiple backend writers are unsupported`,
      );
    }
  }
  const busyTimeoutMs = Number(env.SQLITE_BUSY_TIMEOUT_MS ?? 5000);
  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 1 ||
    busyTimeoutMs > 60000
  ) {
    throw new Error(
      "SQLITE_BUSY_TIMEOUT_MS must be an integer between 1 and 60000",
    );
  }
  return { busyTimeoutMs };
}

export async function configureSqlite(db: sqlite3.Database): Promise<void> {
  db.configure("busyTimeout", sqliteSettings().busyTimeoutMs);
  await new Promise<void>((resolve, reject) => {
    db.get(
      "PRAGMA journal_mode=WAL",
      (err: Error | null, row: { journal_mode: string }) => {
        if (err) reject(err);
        else if (!["wal", "memory"].includes(row.journal_mode))
          reject(new Error("SQLite WAL mode unavailable"));
        else resolve();
      },
    );
  });
}
