import { NetworkBadge } from '../components/NetworkBadge';
import { History } from './History';
import { deployment, setupState } from '../deployment';
import { useThemeContext } from '../providers/ThemeProvider';
import { useWalletContext } from '../providers/WalletProvider';

/**
 * Home screen: deployment-aware wallet setup and history. All wallet and theme state comes from the app providers.
 */
export function Home() {
  const { walletState, address, network, connect, disconnect, error } = useWalletContext();
  const { theme, toggle } = useThemeContext();
  const setup = setupState(walletState, network);

  return (
    <main className="dark:bg-slate-950 dark:text-slate-100 min-h-screen bg-gray-100 px-4 py-6 text-slate-900 transition-colors">
      <div className="mx-auto mb-4 flex max-w-2xl items-center justify-between">
        <NetworkBadge />
        <button
          type="button"
          onClick={toggle}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          className="dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
        >
          {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
        </button>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
        <div>
          <section aria-label="Wallet setup" data-testid={`setup-${setup}`}>
            <h2>Wallet setup</h2>
            <p>Deployment network: {deployment.network}</p>
            {setup === 'disconnected' && (
              <>
                <p
                  data-testid={walletState === 'notInstalled' ? 'wallet-not-installed' : undefined}
                >
                  {walletState === 'notInstalled'
                    ? 'Install Freighter to connect your wallet.'
                    : 'Connect your wallet to get started.'}
                </p>
                <button
                  type="button"
                  onClick={() => void connect()}
                  disabled={['checking', 'connecting', 'notInstalled'].includes(walletState)}
                >
                  Connect wallet
                </button>
              </>
            )}
            {setup === 'unsupported' && (
              <>
                <p>Open Freighter and select {deployment.network}, then reconnect.</p>
                <button type="button" onClick={() => void connect()}>
                  Reconnect wallet
                </button>
              </>
            )}
            {setup === 'unconfigured' && <p>No supported escrow deployment is configured.</p>}
            {setup === 'ready' && (
              <p>Wallet ready on {network}. Wager history is available below.</p>
            )}
            {address && (
              <button type="button" onClick={disconnect}>
                Disconnect wallet
              </button>
            )}
            {error && <p role="alert">{error}</p>}
          </section>
        </div>
        <div>
          <History walletState={walletState} publicKey={address} network={network} />
        </div>
      </div>
    </main>
  );
}
