import { ClaimBurn } from '../components/claim-burn';
import { NetworkBadge } from '../components/NetworkBadge';
import { History } from './History';
import { useTransactions } from '../hooks/useTransactions';
import { useThemeContext } from '../providers/ThemeProvider';
import { useWalletContext } from '../providers/WalletProvider';
import { EligibilityNotice } from '../components/EligibilityNotice';

/**
 * Home screen: header (network badge + theme toggle) plus the Claim/Burn and
 * History panels. All wallet and theme state comes from the app providers.
 */
export function Home() {
  const { walletState, address, balance, network, connect, disconnect, refreshBalance } =
    useWalletContext();
  const { theme, toggle } = useThemeContext();
  const { handleClaim, handleBurn, handleSimulateClaimBurn } = useTransactions(address, network);

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
        <EligibilityNotice />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
        <div>
          <ClaimBurn
            walletState={walletState}
            onConnect={connect}
            onDisconnect={disconnect}
            onRefreshBalance={refreshBalance}
            onClaim={handleClaim}
            onBurn={handleBurn}
            onSimulateTransaction={handleSimulateClaimBurn}
            publicKey={address}
            balance={balance}
            expectedNetwork="testnet"
            network={network}
          />
        </div>
        <div>
          <History walletState={walletState} publicKey={address} />
        </div>
      </div>
    </main>
  );
}