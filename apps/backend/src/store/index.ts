import { SqliteMatchStore } from './sqlite-match-store.js';

export const matchStore = new SqliteMatchStore();

/** Initialize the match store's SQLite database. Call once at startup. */
export async function initializeMatchStore(): Promise<void> {
  await matchStore.initialize();
}

export async function closeMatchStore(): Promise<void> {
  await matchStore.close();
}
