import { NetworkBadge } from '../components/NetworkBadge';
import { History } from './History';
import { useThemeContext } from '../providers/ThemeProvider';
import { useWalletContext } from '../providers/WalletProvider';

/**
 * Home screen: network/theme controls and transaction history. Wallet and
 * theme state come from the app providers.
 */
export function Home() {
  const { walletState, address } = useWalletContext();
  const { theme, toggle } = useThemeContext();

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
      <div className="mx-auto max-w-2xl">
        <History walletState={walletState} publicKey={address} />
      </div>
    </main>
  );
}
