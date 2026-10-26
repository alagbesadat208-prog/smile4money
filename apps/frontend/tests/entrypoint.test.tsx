import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const { rootRender, wallet } = vi.hoisted(() => ({ rootRender: vi.fn(), wallet: vi.fn() }));
vi.mock('react-dom/client', () => ({
  default: { createRoot: vi.fn(() => ({ render: rootRender })) },
}));
vi.mock('../src/hooks/useStellarWallet', () => ({ useStellarWallet: wallet }));
afterEach(cleanup);
it('mounts one routed shell and one wallet provider under StrictMode', async () => {
  wallet.mockReturnValue({
    status: 'disconnected',
    address: null,
    balance: null,
    network: 'testnet',
    connect: vi.fn(),
    disconnect: vi.fn(),
    refreshBalance: vi.fn(),
    isInstalled: false,
  });
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  await import('../src/main');
  expect(rootRender).toHaveBeenCalledTimes(1);
  render(rootRender.mock.calls[0][0] as React.ReactElement);
  expect(screen.getAllByTestId('application-shell')).toHaveLength(1);
  expect(screen.getAllByRole('navigation', { name: 'Primary' })).toHaveLength(1);
  // React StrictMode renders each mounted provider twice in development.
  expect(wallet).toHaveBeenCalledTimes(2);
  root.remove();
});
