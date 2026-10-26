import type { HistoryRow } from './History';

export interface HistoryCacheEntry {
  history: HistoryRow[];
  nextCursor: string | null;
  fetchedAt: number;
}

const historyCache = new Map<string, HistoryCacheEntry>();

export const DEFAULT_HISTORY_CACHE_TTL_MS = 30_000;

export interface HistoryCacheScope {
  network: string;
  contractId: string;
}

function cacheKey(wallet: string, scope: HistoryCacheScope): string {
  return JSON.stringify([wallet, scope.network, scope.contractId]);
}

export function getHistoryCacheEntry(
  wallet: string,
  scope: HistoryCacheScope,
): HistoryCacheEntry | undefined {
  return historyCache.get(cacheKey(wallet, scope));
}

export function setHistoryCacheEntry(
  wallet: string,
  scope: HistoryCacheScope,
  entry: HistoryCacheEntry,
): void {
  historyCache.set(cacheKey(wallet, scope), entry);
}

export function invalidateHistoryCache(wallet?: string): void {
  if (wallet) {
    for (const key of historyCache.keys()) {
      if (JSON.parse(key)[0] === wallet) historyCache.delete(key);
    }
  } else {
    historyCache.clear();
  }
}