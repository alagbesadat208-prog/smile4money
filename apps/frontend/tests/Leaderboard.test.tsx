import { Asset, Networks } from '@stellar/stellar-sdk';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Leaderboard, decodeEntries } from '../src/pages/Leaderboard';
import type { LeaderboardEntry } from '../src/pages/Leaderboard';

// jsdom's Uint8Array belongs to a different realm from Node's SDK Buffer.
vi.hoisted(() => vi.stubGlobal('Uint8Array', new globalThis.TextEncoder().encode('').constructor));

vi.mock('@stellar/stellar-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stellar/stellar-sdk')>()),
  Account: class {
    constructor(
      public _address: string,
      public _sequence: string,
    ) {}
  },
  Operation: { invokeContractFunction: vi.fn() },
  TransactionBuilder: class {
    addOperation() {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return {};
    }
  },
  nativeToScVal: vi.fn(),
  rpc: { Server: vi.fn() },
  scValToNative: vi.fn(),
}));

/**
 * The page's job is to render rows and page between them without
 * re-implementing the contract's ranking. These tests inject `fetchPage` so no
 * RPC is involved, and assert the two things the page is actually responsible
 * for: showing what the contract returned, and not showing the wrong page.
 */

const CONTRACT = 'CDUMMYCONTRACTID';

function entry(player: string, wins: number, earnings: string): LeaderboardEntry {
  return {
    player,
    stats: { wins, losses: 0, draws: 0, earnings, token: 'CTOKENADDRESS' },
  };
}

/** Build `count` rows with descending wins. */
function rows(count: number): LeaderboardEntry[] {
  return Array.from({ length: count }, (_, i) =>
    entry(`GPLAYER${String(i).padStart(3, '0')}XXXXXXXXXX`, count - i, String((count - i) * 1000)),
  );
}

const PAGE_SIZE = 25;

beforeEach(() => vi.clearAllMocks());

describe('Leaderboard â€” rendering', () => {
  it('shows a loading state before rows arrive', () => {
    render(<Leaderboard contractId={CONTRACT} fetchPage={() => new Promise(() => {})} />);
    expect(screen.getByTestId('leaderboard-loading')).toBeInTheDocument();
  });

  it('renders a row per entry with wins, losses, draws and earnings', async () => {
    const fetchPage = vi.fn().mockResolvedValue([entry('GAAA', 5, '2500')]);
    render(<Leaderboard contractId={CONTRACT} fetchPage={fetchPage} />);

    await screen.findByTestId('leaderboard-table');
    expect(screen.getAllByTestId('leaderboard-row')).toHaveLength(1);
    expect(screen.getByText('5')).toBeInTheDocument();
    // Unknown assets retain their raw, explicitly named denomination.
    expect(screen.getByText('2500 smallest units (CTOKENADDRESS)')).toBeInTheDocument();
  });

  it('displays verified native earnings in XLM with exact decimals', async () => {
    const row = entry('GAAA', 1, '15000001');
    row.stats.token = Asset.native().contractId(Networks.TESTNET);
    render(<Leaderboard contractId={CONTRACT} fetchPage={vi.fn().mockResolvedValue([row])} />);
    expect(await screen.findByText('1.5000001 XLM')).toBeInTheDocument();
  });

  it('shows an empty state when nobody has played', async () => {
    render(<Leaderboard contractId={CONTRACT} fetchPage={vi.fn().mockResolvedValue([])} />);
    expect(await screen.findByTestId('leaderboard-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('leaderboard-table')).not.toBeInTheDocument();
  });

  it('surfaces a fetch failure as an alert', async () => {
    const fetchPage = vi.fn().mockRejectedValue(new Error('RPC unavailable'));
    render(<Leaderboard contractId={CONTRACT} fetchPage={fetchPage} />);

    const alert = await screen.findByTestId('leaderboard-error');
    expect(alert).toHaveTextContent('RPC unavailable');
    expect(alert).toHaveAttribute('role', 'alert');
  });

  it('shortens a long address for display but keeps the full one in the title', async () => {
    const long = 'GAUXUJLYWYXK7UE22KXN5WJTP2MNOWVL4ZRDBJQ43WZB5HJP22JSYTRR';
    render(
      <Leaderboard
        contractId={CONTRACT}
        fetchPage={vi.fn().mockResolvedValue([entry(long, 1, '1')])}
      />,
    );
    await screen.findByTestId('leaderboard-table');
    expect(screen.getByTitle(long)).toHaveTextContent('GAUXâ€¦YTRR');
  });
});

describe('Leaderboard â€” column headers', () => {
  it('labels every column so the table is readable', async () => {
    render(<Leaderboard contractId={CONTRACT} fetchPage={vi.fn().mockResolvedValue(rows(2))} />);
    await screen.findByTestId('leaderboard-table');
    for (const header of ['#', 'Player', 'W', 'L', 'D', 'Earnings']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
  });
});

describe('Leaderboard — pagination', () => {
  it('disables Previous on the first page', async () => {
    render(<Leaderboard contractId={CONTRACT} fetchPage={vi.fn().mockResolvedValue(rows(2))} />);
    await screen.findByTestId('leaderboard-table');
    expect(screen.getByTestId('leaderboard-prev')).toBeDisabled();
  });

  it('disables Next on a short page, since there is nothing after it', async () => {
    // Two rows is fewer than a page, so this is already the last page.
    render(<Leaderboard contractId={CONTRACT} fetchPage={vi.fn().mockResolvedValue(rows(2))} />);
    await screen.findByTestId('leaderboard-table');
    expect(screen.getByTestId('leaderboard-next')).toBeDisabled();
  });

  it('enables Next on a full page', async () => {
    render(
      <Leaderboard contractId={CONTRACT} fetchPage={vi.fn().mockResolvedValue(rows(PAGE_SIZE))} />,
    );
    await screen.findByTestId('leaderboard-table');
    expect(screen.getByTestId('leaderboard-next')).toBeEnabled();
  });

  it('requests the next page with an offset', async () => {
    // A full page first, then a short one, so Next stays enabled after page 1.
    const fetchPage = vi.fn().mockResolvedValueOnce(rows(PAGE_SIZE)).mockResolvedValueOnce(rows(3));
    render(<Leaderboard contractId={CONTRACT} fetchPage={fetchPage} />);
    await screen.findByTestId('leaderboard-table');

    await userEvent.click(screen.getByTestId('leaderboard-next'));

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(fetchPage.mock.calls[0]).toEqual([PAGE_SIZE, 0]);
    // Offset, not page number: the contract pages by offset.
    expect(fetchPage.mock.calls[1]).toEqual([PAGE_SIZE, PAGE_SIZE]);
  });

  it('numbers rows continuously across pages', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(rows(PAGE_SIZE)).mockResolvedValueOnce(rows(2));
    render(<Leaderboard contractId={CONTRACT} fetchPage={fetchPage} />);
    await screen.findByTestId('leaderboard-table');

    await userEvent.click(screen.getByTestId('leaderboard-next'));

    await waitFor(() => expect(screen.getAllByTestId('leaderboard-row')).toHaveLength(2));
    // Page 2 starts at rank PAGE_SIZE + 1, not at 1.
    expect(screen.getByText(String(PAGE_SIZE + 1))).toBeInTheDocument();
  });

  it('goes back to the previous page', async () => {
    // Three loads, three responses: page 1, page 2, and page 1 again.
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(rows(PAGE_SIZE))
      .mockResolvedValueOnce(rows(2))
      .mockResolvedValue(rows(PAGE_SIZE));
    render(<Leaderboard contractId={CONTRACT} fetchPage={fetchPage} />);
    await screen.findByTestId('leaderboard-table');

    await userEvent.click(screen.getByTestId('leaderboard-next'));
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByTestId('leaderboard-prev'));
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    // Paging back re-requests offset 0 rather than reusing cached rows.
    expect(fetchPage.mock.calls[2]).toEqual([PAGE_SIZE, 0]);
    await waitFor(() => expect(screen.getAllByTestId('leaderboard-row')).toHaveLength(PAGE_SIZE));
  });

  it('keeps the rows the contract returned, in the order it returned them', async () => {
    // The page must not re-sort. If it did, this ordering would change.
    const fetchPage = vi.fn().mockResolvedValue([entry('GAAA', 9, '1'), entry('GBBB', 1, '1')]);
    render(<Leaderboard contractId={CONTRACT} fetchPage={fetchPage} />);
    await screen.findByTestId('leaderboard-table');

    const cells = screen.getAllByTestId('leaderboard-row').map((r) => r.textContent);
    expect(cells[0]).toContain('9');
    expect(cells[1]).toContain('1');
  });
});

describe('decodeEntries', () => {
  it('rejects a response that is not a list', async () => {
    const { scValToNative } = await import('@stellar/stellar-sdk');
    vi.mocked(scValToNative).mockReturnValue({ not: 'a list' } as never);
    expect(() => decodeEntries('anything')).toThrow(/Unexpected response/);
  });

  it('rejects an entry that is missing its stats', async () => {
    const { scValToNative } = await import('@stellar/stellar-sdk');
    vi.mocked(scValToNative).mockReturnValue([{ player: 'GAAA' }] as never);
    expect(() => decodeEntries('anything')).toThrow(/Unexpected leaderboard entry shape/);
  });

  it('keeps earnings as a string so large values are not rounded', async () => {
    const { scValToNative } = await import('@stellar/stellar-sdk');
    // 2^53 + 1 - the value a float would silently round.
    vi.mocked(scValToNative).mockReturnValue([
      {
        player: 'GAAA',
        stats: { wins: 1n, losses: 0n, draws: 0n, earnings: 9007199254740993n, token: 'CTOK' },
      },
    ] as never);
    const out = decodeEntries('anything');
    expect(out[0].stats.earnings).toBe('9007199254740993');
  });
});
