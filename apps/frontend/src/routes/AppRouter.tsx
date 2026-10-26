import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { Home } from '../pages/Home';
import { NotFound } from '../pages/NotFound';
import { Leaderboard } from '../pages/Leaderboard';
import { Wager } from '../pages/Wager';

const leaderboardId =
  (import.meta as { env?: { VITE_LEADERBOARD_CONTRACT_ID?: string } }).env
    ?.VITE_LEADERBOARD_CONTRACT_ID ?? '';

export function AppRouter() {
  return (
    <BrowserRouter>
      <div data-testid="application-shell">
        <nav aria-label="Primary">
          <Link to="/">Home</Link> <Link to="/create-match">Create match</Link>{' '}
          <Link to="/deposit">Deposit</Link> <Link to="/matches">Match details</Link>{' '}
          <Link to="/history">History</Link> <Link to="/leaderboard">Leaderboard</Link>
        </nav>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/create-match" element={<Wager page="create" />} />
          <Route path="/deposit" element={<Wager page="deposit" />} />
          <Route path="/matches" element={<Wager page="details" />} />
          <Route path="/matches/:matchId" element={<Wager page="details" />} />
          <Route path="/matches/:matchId/deposit" element={<Wager page="deposit" />} />
          <Route path="/history" element={<Wager page="history" />} />
          <Route path="/leaderboard" element={<Leaderboard contractId={leaderboardId} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
