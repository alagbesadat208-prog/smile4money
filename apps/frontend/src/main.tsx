import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { App } from './App';
import { NotFound } from './pages/NotFound';
import { Leaderboard } from './pages/Leaderboard';
import { ToastProvider } from './components/Toast';
import './app/globals.css';
// Layout + component styles for CreateMatch / DepositStake / MatchStatus.
// Imported here because nothing else pulls it in — see the header of the file
// for why these three components were previously unstyled.
import './styles/match-ui.css';
import './styles/global-ui.css';

/**
 * Deployed `smile4money-leaderboard` contract id.
 *
 * Read from Vite's env at build time rather than hard-coded, so a deployment
 * targets its own contract without a source change. `VITE_` is the prefix Vite
 * exposes to client code; anything else never reaches the browser bundle.
 *
 * The `import.meta` cast mirrors `useStellarWallet.ts`: `ImportMeta.env` is
 * augmented in `useWallet.ts` with only `VITE_STELLAR_NETWORK`, so a second
 * `declare global` here would declare a conflicting type for the same `env`
 * property.
 *
 * Empty when unset, which the page reports as "no contract configured" rather
 * than firing a request at a blank address.
 */
const LEADERBOARD_CONTRACT_ID =
  (import.meta as { env?: { VITE_LEADERBOARD_CONTRACT_ID?: string } }).env
    ?.VITE_LEADERBOARD_CONTRACT_ID ?? '';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/leaderboard" element={<Leaderboard contractId={LEADERBOARD_CONTRACT_ID} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
    <App />
  </React.StrictMode>,
);