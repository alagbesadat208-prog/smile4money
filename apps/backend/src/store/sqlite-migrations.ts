import sqlite3 from 'sqlite3';

export interface SqliteMigration {
  version: number;
  name: string;
  statements: string[];
}

function run(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => db.run(sql, (error) => (error ? reject(error) : resolve())));
}
function getVersion(db: sqlite3.Database): Promise<number> {
  return new Promise((resolve, reject) =>
    db.get('SELECT MAX(version) AS version FROM schema_version', (error, row: any) =>
      error ? reject(error) : resolve(row?.version ?? 0),
    ),
  );
}

/** Apply ordered schema changes one transaction at a time. A failed migration
 * rolls back both its DDL and version marker, so startup can safely retry. */
export async function applySqliteMigrations(db: sqlite3.Database, migrations: SqliteMigration[]): Promise<void> {
  await run(
    db,
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  );
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const current = await getVersion(db);
  if (current > (ordered[ordered.length - 1]?.version ?? 0)) {
    throw new Error(`SQLite schema version ${current} is newer than this application supports`);
  }
  for (const migration of ordered) {
    if (migration.version <= current) continue;
    await run(db, 'BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) await run(db, statement);
      await new Promise<void>((resolve, reject) =>
        db.run(
          'INSERT INTO schema_version(version, name, applied_at) VALUES (?, ?, ?)',
          [migration.version, migration.name, Date.now()],
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      await run(db, 'COMMIT');
    } catch (error) {
      await run(db, 'ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}
