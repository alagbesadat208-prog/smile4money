import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
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
});

describe('History deployment isolation', () => {
  beforeEach(() => invalidateHistoryCache());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    { network: 'mainnet', contractId: 'contract-a' },
    { network: 'testnet', contractId: 'contract-b' },
  ])('misses cache after deployment changes to %j', async (deployment) => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new globalThis.Response(JSON.stringify(historyResponse()), { status: 200 }),
      );
    const first = render(
      <History
        walletState="connected"
        publicKey={wallet}
        network="testnet"
        contractId="contract-a"
      />,
    );
    await screen.findByTestId('history-row');
    first.unmount();
    const second = render(<History walletState="connected" publicKey={wallet} {...deployment} />);
    await screen.findByTestId('history-row');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.unmount();
    render(
      <History
        walletState="connected"
        publicKey={wallet}
        network="testnet"
        contractId="contract-a"
      />,
    );
    expect(screen.getByTestId('history-row')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

it('ignores a response from the previous deployment after switching', async () => {
  invalidateHistoryCache();
  let resolveOld!: (response: globalThis.Response) => void;
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockImplementation(
      async () =>
        new globalThis.Response(JSON.stringify({ _embedded: { records: [] } }), { status: 200 }),
    );
  const view = render(
    <History walletState="connected" publicKey={wallet} network="testnet" contractId="old" />,
  );
  view.rerender(
    <History walletState="connected" publicKey={wallet} network="testnet" contractId="new" />,
  );
  await screen.findByTestId('history-empty');
  await act(async () => {
    resolveOld(new globalThis.Response(JSON.stringify(historyResponse()), { status: 200 }));
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByTestId('history-row')).not.toBeInTheDocument();
  view.unmount();
  vi.restoreAllMocks();
});
