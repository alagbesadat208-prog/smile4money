import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { History } from '../../src/pages/History';
import { invalidateHistoryCache } from '../../src/pages/history-cache';

const wallet = 'GTESTWALLET';

function historyResponse() {
  return {
    _embedded: {
      records: [
        {
          hash: 'tx-1',
          source_account: wallet,
          successful: true,
          memo: '42',
          fee_charged: '10',
          created_at: '2026-01-01T00:00:00Z',
          _links: { self: { href: 'https://example.test/tx-1' } },
        },
      ],
    },
  };
}

describe('History cache', () => {
  beforeEach(() => {
    invalidateHistoryCache();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not call the API again on a second navigation within the TTL', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new globalThis.Response(JSON.stringify(historyResponse()), { status: 200 }),
      );

    const first = render(
      <History walletState="connected" publicKey={wallet} cacheTtlMs={60_000} />,
    );
    await waitFor(() => expect(screen.getByTestId('history-row')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.unmount();
    render(<History walletState="connected" publicKey={wallet} cacheTtlMs={60_000} />);

    expect(screen.getByTestId('history-row')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('keeps unrelated successful transactions out of wager results', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new globalThis.Response(JSON.stringify(historyResponse()), { status: 200 }),
    );
    render(<History walletState="connected" publicKey={wallet} />);
    await screen.findByTestId('history-row');
    expect(screen.getByText('Network Transaction Details')).toBeInTheDocument();
    expect(screen.getByText('10 stroops')).toBeInTheDocument();
    expect(screen.queryByText('Win')).not.toBeInTheDocument();
    expect(screen.queryByText('42')).not.toBeInTheDocument();
  });
});
