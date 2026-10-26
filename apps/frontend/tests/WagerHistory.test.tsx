import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { WagerHistory } from '../src/pages/WagerHistory';
import { fetchWagerPage } from '../src/pages/wager-history';
vi.mock('../src/deployment', () => ({ deploymentReady: true }));
vi.mock('../src/pages/wager-history', () => ({ fetchWagerPage: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it('renders escrow rows and advances a bounded page', async () => {
  vi.mocked(fetchWagerPage)
    .mockResolvedValueOnce({
      rows: [{ id: '42', opponent: 'bob', stake: '1 XLM', result: 'Win', payout: '2 XLM' }],
      cursor: 20n,
    })
    .mockResolvedValueOnce({ rows: [], cursor: 0n });
  render(<WagerHistory wallet="alice" />);
  expect(await screen.findByText('Win')).toBeInTheDocument();
  expect(screen.getByText('2 XLM')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Older escrow records' }));
  await screen.findByText('No wagers in this page of escrow records.');
  expect(fetchWagerPage).toHaveBeenLastCalledWith('alice', 20n);
});
it('reports errors without inventing wager results', async () => {
  vi.mocked(fetchWagerPage).mockRejectedValue(new Error('RPC unavailable'));
  render(<WagerHistory wallet="alice" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('RPC unavailable');
});
it('ignores responses after unmount', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof fetchWagerPage>>) => void;
  vi.mocked(fetchWagerPage).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(<WagerHistory wallet="alice" />);
  view.unmount();
  resolve({ rows: [], cursor: 0n });
  await waitFor(() =>
    expect(screen.queryByText('No wagers in this page of escrow records.')).not.toBeInTheDocument(),
  );
});
