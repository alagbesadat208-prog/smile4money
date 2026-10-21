import { WagerHistory } from './WagerHistory';
import { deployment } from '../deployment';
import { useEffect, useState, useCallback } from 'react';
import type { WalletStatus } from '../types';
import {
  DEFAULT_HISTORY_CACHE_TTL_MS,
  getHistoryCacheEntry,
  setHistoryCacheEntry,
} from './history-cache';

const HORIZON_URL = deployment.horizonUrl;
const PAGE_SIZE = 20;

interface HistoryProps {
  walletState: WalletStatus;
  publicKey?: string | null;
  cacheTtlMs?: number;
}

interface HorizonTransaction {
  hash: string;
  source_account: string;
  successful: boolean;
  memo: string | null;
  fee_charged: string;
  created_at: string;
  _links: {
    self: { href: string };
  };
}

interface HorizonResponse {
  _embedded?: { records: HorizonTransaction[] };
  _links?: {
    next?: { href: string };
    prev?: { href: string };
  };
}

export interface HistoryRow {
  id: string;
  hash: string;
  source: string;
  fee: string;
  status: string;
  date: string;
}

function parseCursor(href: string): string | null {
  try {
    const url = new URL(href);
    return url.searchParams.get('cursor');
  } catch {
    return null;
  }
}

function mapRecord(record: HorizonTransaction): HistoryRow {
  return {
    id: record.hash,
    hash: record.hash,
    source: record.source_account,
    fee: `${record.fee_charged} stroops`,
    status: record.successful ? 'Success' : 'Failed',
    date: new Date(record.created_at).toLocaleString(),
  };
}

export function History({
  walletState,
  publicKey,
  cacheTtlMs = DEFAULT_HISTORY_CACHE_TTL_MS,
}: HistoryProps) {
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cursor for the *next* page; null means we are on the first page or there
  // are no more results.
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  /** Fetch a page of transactions. When `cursor` is null the first page is
   *  fetched; otherwise the page starting after `cursor` is fetched and
   *  appended to the existing history (Load More behaviour). */
  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean, background = false) => {
      if (!publicKey) return;

      if (append) {
        setLoadingMore(true);
      } else if (!background) {
        setLoading(true);
      }
      setError(null);

      const url = new URL(`${HORIZON_URL}/accounts/${publicKey}/transactions`);
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('order', 'desc');
      if (cursor) url.searchParams.set('cursor', cursor);

      try {
        const response = await fetch(url.toString());
        if (!response.ok) {
          throw new Error('Unable to load transaction history');
        }
        const data = (await response.json()) as HorizonResponse;
        const records: HorizonTransaction[] = data._embedded?.records ?? [];

        const rows = records.map((r) => mapRecord(r));

        setHistory((prev) => (append ? [...prev, ...rows] : rows));

        // If the API returned fewer records than PAGE_SIZE there are no more
        // pages, so we intentionally clear nextCursor to hide the Load More
        // button.
        const nextHref = data._links?.next?.href;
        const derived = nextHref ? parseCursor(nextHref) : null;
        setNextCursor(records.length < PAGE_SIZE ? null : derived);
        if (!append) {
          setHistoryCacheEntry(publicKey, {
            history: rows,
            nextCursor: records.length < PAGE_SIZE ? null : derived,
            fetchedAt: Date.now(),
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load history');
      } finally {
        if (append) {
          setLoadingMore(false);
        } else {
          setLoading(false);
        }
      }
    },
    [publicKey],
  );

  // Reset and reload whenever the connected wallet changes.
  useEffect(() => {
    if (walletState !== 'connected' || !publicKey) {
      setHistory([]);
      setNextCursor(null);
      setError(null);
      setLoading(false);
      return;
    }

    const cached = getHistoryCacheEntry(publicKey);
    const hasFreshCache = cached && Date.now() - cached.fetchedAt < cacheTtlMs;
    if (cached) {
      setHistory(cached.history);
      setNextCursor(cached.nextCursor);
    } else {
      setNextCursor(null);
    }
    if (!cached || !hasFreshCache) {
      void fetchPage(null, false, Boolean(cached));
    }
    // fetchPage is stable (memoised on publicKey); re-run when publicKey or
    // walletState changes.
  }, [publicKey, walletState, cacheTtlMs, fetchPage]);

  function handleLoadMore() {
    if (nextCursor && !loadingMore) {
      void fetchPage(nextCursor, true);
    }
  }

  if (walletState !== 'connected') {
    return (
      <section className="history-page" data-testid="history-page">
        <h2>Transaction History</h2>
        <p>Please connect your wallet to view history.</p>
      </section>
    );
  }

  return (
    <section className="history-page" data-testid="history-page">
      {publicKey && <WagerHistory key={publicKey} wallet={publicKey} />}
      <h2>Network Transaction Details</h2>
      <p>Network fees and transaction status do not establish wager outcomes.</p>

      {loading && <p data-testid="history-loading">Loading history…</p>}

      {error && (
        <p className="history-error" role="alert" data-testid="history-error">
          {error}
        </p>
      )}

      {!loading && !error && history.length === 0 && (
        <p data-testid="history-empty">No network transactions found for this wallet.</p>
      )}

      {!loading && history.length > 0 && (
        <>
          <div className="history-table-wrap">
            <table className="history-table" data-testid="history-table">
              <thead>
                <tr>
                  <th>Transaction hash</th>
                  <th>Source account</th>
                  <th>Network fee</th>
                  <th>Transaction status</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} data-testid="history-row">
                    <td>{row.hash}</td>
                    <td>{row.source}</td>
                    <td>{row.fee}</td>
                    <td>{row.status}</td>
                    <td>{row.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Load More — hidden once all pages are exhausted */}
          {nextCursor && (
            <div className="history-load-more">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={loadingMore}
                onClick={handleLoadMore}
                data-testid="history-load-more"
                aria-busy={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}

          {loadingMore && (
            <p data-testid="history-loading-more" aria-live="polite">
              Loading more transactions…
            </p>
          )}
        </>
      )}
    </section>
  );
}
