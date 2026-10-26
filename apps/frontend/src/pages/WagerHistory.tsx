import { useEffect, useState } from 'react';
import { fetchWagerPage } from './wager-history';
import { deploymentReady } from '../deployment';

export function WagerHistory({ wallet }: { wallet: string }) {
  const [page, setPage] = useState<Awaited<ReturnType<typeof fetchWagerPage>> | null>(null);
  const [before, setBefore] = useState<bigint>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!deploymentReady) return;
    let active = true;
    fetchWagerPage(wallet, before)
      .then((value) => {
        if (active) setPage(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load wagers');
      });
    return () => {
      active = false;
    };
  }, [wallet, before]);
  return (
    <section aria-label="Wager history">
      <h2>Wager History</h2>
      {!deploymentReady ? (
        <p>No supported escrow deployment is configured.</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : !page ? (
        <p>Loading wagers…</p>
      ) : (
        <>
          {page.rows.length === 0 ? (
            <p>No wagers in this page of escrow records.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  {['Match ID', 'Opponent', 'Stake', 'Result', 'Payout'].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={row.id}>
                    {Object.values(row).map((value, index) => (
                      <td key={index}>{value}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {page.cursor > 0n && (
            <button
              type="button"
              onClick={() => {
                setPage(null);
                setBefore(page.cursor);
              }}
            >
              Older escrow records
            </button>
          )}
        </>
      )}
    </section>
  );
}
