import { fileURLToPath } from 'node:url';
import { SqliteEvidenceStore } from './evidence-store.js';
import { SqliteMatchStore } from './sqlite-match-store.js';

export const matchStore = new SqliteMatchStore();

export const evidenceStore = new SqliteEvidenceStore(process.env.ORACLE_EVIDENCE_DB ?? fileURLToPath(new URL('../../data/oracle-evidence.db', import.meta.url)));

/** Initialize the match store's SQLite database. Call once at startup. */
export async function initializeMatchStore(): Promise<void> {
  await matchStore.initialize();
  await evidenceStore.initialize();
}

export async function closeMatchStore(): Promise<void> {
  await matchStore.close();
}
