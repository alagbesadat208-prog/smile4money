/**
 * Oracle database backup CLI (#104). See docs/oracle-db-recovery.md.
 *
 *   tsx src/cli/db-backup.ts backup  <database> <backup-dir>
 *   tsx src/cli/db-backup.ts verify  <backup-file>
 *   tsx src/cli/db-backup.ts restore <backup-file> <database>   # service stopped
 *   tsx src/cli/db-backup.ts prune   <database> <backup-dir> [retention-days]
 *
 * `backup` also verifies the new file and prunes old ones, so one scheduled
 * command covers the whole routine. Exits non-zero on any failure, so a
 * scheduler or monitor sees a missed backup.
 */
import path from 'path';
import {
  backupFileName,
  backupSqliteDatabase,
  pruneBackups,
  restoreSqliteDatabase,
  verifySqliteBackup,
} from '../store/sqlite-backup.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Default retention, matching docs/oracle-db-recovery.md. */
export const DEFAULT_RETENTION_DAYS = 35;

function retentionMs(raw: string | undefined): number {
  const days = raw === undefined ? DEFAULT_RETENTION_DAYS : Number(raw);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`invalid retention days: ${raw}`);
  return days * DAY_MS;
}

export async function main(argv: string[]): Promise<number> {
  const [command, a, b, c] = argv;
  switch (command) {
    case 'backup': {
      if (!a || !b) break;
      const target = path.join(b, backupFileName(a));
      await backupSqliteDatabase(a, target);
      const check = await verifySqliteBackup(target);
      if (!check.ok) {
        console.error(`backup written but failed verification: ${check.integrity.join('; ')}`);
        return 1;
      }
      const pruned = pruneBackups(b, a, retentionMs(c));
      console.log(JSON.stringify({ backup: target, tables: check.tables, pruned }));
      return 0;
    }
    case 'verify': {
      if (!a) break;
      const check = await verifySqliteBackup(a);
      console.log(JSON.stringify(check));
      return check.ok ? 0 : 1;
    }
    case 'restore': {
      if (!a || !b) break;
      const check = await restoreSqliteDatabase(a, b);
      console.log(JSON.stringify({ restored: b, from: a, tables: check.tables }));
      return 0;
    }
    case 'prune': {
      if (!a || !b) break;
      console.log(JSON.stringify({ pruned: pruneBackups(b, a, retentionMs(c)) }));
      return 0;
    }
  }
  console.error(
    'usage: db-backup <backup|verify|restore|prune> ... (see docs/oracle-db-recovery.md)',
  );
  return 2;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked.endsWith(`${path.sep}db-backup.ts`) || invoked.endsWith(`${path.sep}db-backup.js`)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
