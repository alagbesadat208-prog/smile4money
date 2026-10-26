import { useEffect, useState } from 'react';
import { Account, Operation, TransactionBuilder, nativeToScVal, rpc, scValToNative } from '@stellar/stellar-sdk';
import { APP_NETWORK_CONFIG } from '../config/network';

/**
 * Leaderboard page â€” issue #124 / #1803.
 *
 * Renders the on-chain `get_leaderboard(limit, offset)` view produced by the
 * `smile4money-leaderboard` contract.
 *
 * ## Why a simulate rather than a signed call
 *
 * `get_leaderboard` is read-only, so it is invoked through
 * `simulateTransaction` â€” the same pattern `DepositStake` uses to read
 * `get_match`. No wallet signature is needed, so the page renders for visitors
 * who have not connected. The simulation source only has to exist on the
 * ledger; the contract's own address is used, which works with no wallet.
 *
 * ## Ranking and paging are server-side
 *
 * The contract sorts and paginates. This page deliberately does not re-sort or
 * merge pages client-side, because a client-side merge would need every row to
 * be correct globally â€” re-implementing, and probably getting subtly wrong,
 * exactly the tie-breaking the contract already does.
 */

const DEFAULT_RPC_URL = APP_NETWORK_CONFIG.rpcUrl;

/** Must match `MAX_PAGE_SIZE` in `contracts/leaderboard/src/types.rs`. */
const PAGE_SIZE = 25;

export interface LeaderboardStats {
  wins: number;
  losses: number;
  draws: number;
  earnings: string;
  token: string;
}

export interface LeaderboardEntry {
  player: string;
  stats: LeaderboardStats;
}

interface LeaderboardProps {
  contractId: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  /** Injectable for tests; defaults to a real Soroban RPC simulation. */
  fetchPage?: (limit: number, offset: number) => Promise<LeaderboardEntry[]>;
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Convert the returned `Vec<LeaderboardEntry>` into plain rows.
 *
 * `scValToNative` is used rather than hand-rolled XDR walking so a change to
 * the struct's shape surfaces as a clear error here instead of a misread
 * field.
 */
export function decodeEntries(retval: unknown): LeaderboardEntry[] {
  const raw = scValToNative(retval as never) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error('Unexpected response from LeaderboardContract.get_leaderboard');
  }

  return raw.map((row) => {
    const entry = row as Record<string, unknown>;
    const stats = entry.stats as Record<string, unknown> | undefined;
    if (!entry.player || !stats) {
      throw new Error('Unexpected leaderboard entry shape');
    }
    return {
      player: String(entry.player),
      stats: {
        wins: Number(stats.wins ?? 0),
        losses: Number(stats.losses ?? 0),
        draws: Number(stats.draws ?? 0),
        // `i128` decodes to a BigInt. Keep the raw string for display so large
        // earnings figures are not mangled by Number precision loss.
        earnings: String(stats.earnings ?? '0'),
        token: String(stats.token ?? ''),
      },
    };
  });
}

/** Default read path: simulate a `get_leaderboard` call over Soroban RPC. */
export async function fetchLeaderboardPage(
  contractId: string,
  limit: number,
  offset: number,
  rpcUrl: string,
  networkPassphrase: string,
): Promise<LeaderboardEntry[]> {
  const server = new rpc.Server(rpcUrl);
  // The contract's own address is used as the simulation source. It only has
  // to exist on the ledger for a read-only simulation, so this works with no
  // wallet connected. Constructing an `Account` with a dummy sequence is the
  // same approach `DepositStake` uses to read `get_match`.
  const source = new Account(contractId, '0');

  const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'get_leaderboard',
        args: [nativeToScVal(limit, { type: 'u32' }), nativeToScVal(offset, { type: 'u32' })],
      }),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if ('error' in sim) {
    throw new Error(`Could not load the leaderboard: ${sim.error}`);
  }
  if (!sim.result?.retval) {
    throw new Error('Could not load the leaderboard: the RPC server returned no result');
  }
  return decodeEntries(sim.result.retval);
}

/** Shorten an address for display, e.g. `GABCâ€¦WXYZ`. */
function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}â€¦${address.slice(-4)}` : address;
}

/** Format a raw smallest-unit amount with thousands separators. */
function formatAmount(value: string): string {
  try {
    return BigInt(value).toLocaleString();
  } catch {
    return value;
  }
}

export function Leaderboard({
  contractId,
  rpcUrl = DEFAULT_RPC_URL,
  networkPassphrase = APP_NETWORK_CONFIG.networkPassphrase,
  fetchPage,
}: LeaderboardProps) {
  const [page, setPage] = useState(0);
  // Results and errors are stored together with the request that produced
  // them, so `status` can be derived rather than tracked separately. Keying
  // them is what stops a slow page-1 response from painting rows under the
  // page-2 heading.
  const [loaded, setLoaded] = useState<{ key: string; rows: LeaderboardEntry[] } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);

  const offset = page * PAGE_SIZE;
  const requestKey = `${contractId}|${rpcUrl}|${networkPassphrase}|${offset}`;

  useEffect(() => {
    // Nothing configured to read from. The derived status below already
    // reports `idle`, so there is no state to set here.
    if (!contractId) return;

    // `active` guards against a stale response landing after the user has
    // paged away, which would render the previous page under the new page.
    let active = true;

    const load = fetchPage
      ? fetchPage(PAGE_SIZE, offset)
      : fetchLeaderboardPage(contractId, PAGE_SIZE, offset, rpcUrl, networkPassphrase);

    load
      .then((rows) => {
        if (!active) return;
        setLoaded({ key: requestKey, rows });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setFailed({
          key: requestKey,
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      });

    return () => {
      active = false;
    };
    // `requestKey` encodes every input this load depends on.
  }, [contractId, rpcUrl, networkPassphrase, fetchPage, offset, requestKey]);

  // Derived rather than stored, so no synchronous setState is needed in the
  // effect body.
  const status: LoadStatus = !contractId
    ? 'idle'
    : failed?.key === requestKey
      ? 'error'
      : loaded?.key === requestKey
        ? 'ready'
        : 'loading';

  const entries = loaded?.key === requestKey ? loaded.rows : [];
  const error = failed?.key === requestKey ? failed.message : null;

  // A short page means this is the last one, so Next is disabled rather than
  // inviting a click that would come back as an InvalidRange error.
  const isLastPage = entries.length < PAGE_SIZE;

  return (
    <section className="leaderboard" data-testid="leaderboard">
      <h2 className="leaderboard-title">Leaderboard</h2>

      {status === 'loading' && (
        <p className="loading-message" data-testid="leaderboard-loading">
          Loading leaderboard&hellip;
        </p>
      )}

      {status === 'error' && (
        <p className="feedback error" role="alert" data-testid="leaderboard-error">
          {error}
        </p>
      )}

      {status === 'ready' && entries.length === 0 && (
        <p className="no-match-message" data-testid="leaderboard-empty">
          No completed matches yet.
        </p>
      )}

      {entries.length > 0 && (
        <>
          <div className="history-table-wrap">
            <table className="history-table" data-testid="leaderboard-table">
              <caption className="sr-only">
                Top players by wins, with losses, draws and total earnings
              </caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Player</th>
                  <th scope="col">W</th>
                  <th scope="col">L</th>
                  <th scope="col">D</th>
                  <th scope="col">Earnings</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => (
                  <tr key={entry.player} data-testid="leaderboard-row">
                    <td>{page * PAGE_SIZE + index + 1}</td>
                    <td>
                      <span className="address" title={entry.player}>
                        {shortAddress(entry.player)}
                      </span>
                    </td>
                    <td>{entry.stats.wins}</td>
                    <td>{entry.stats.losses}</td>
                    <td>{entry.stats.draws}</td>
                    <td>
                      {formatAmount(entry.stats.earnings)}
                      {entry.stats.token && (
                        <span className="address-small">
                          {' '}
                          {shortAddress(entry.stats.token)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav className="history-pagination" aria-label="Leaderboard pages">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              data-testid="leaderboard-prev"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={isLastPage}
              data-testid="leaderboard-next"
            >
              Next
            </button>
          </nav>
        </>
      )}
    </section>
  );
}

export default Leaderboard;
