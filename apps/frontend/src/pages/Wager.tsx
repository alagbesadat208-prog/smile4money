import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Networks } from '@stellar/stellar-sdk';
import { CreateMatch } from '../components/CreateMatch';
import { DepositStake } from '../components/DepositStake';
import { MatchStatus } from '../components/MatchStatus';
import { History } from './History';
import { useWalletContext } from '../providers/WalletProvider';
import { useTransactions } from '../hooks/useTransactions';
import { escrowRpcUrl, fetchMatchStatus } from '../services/escrow';

const contractId =
  (import.meta as { env?: { VITE_ESCROW_CONTRACT_ID?: string } }).env?.VITE_ESCROW_CONTRACT_ID ??
  '';

export function Wager({ page }: { page: 'create' | 'deposit' | 'details' | 'history' }) {
  const wallet = useWalletContext();
  const { matchId = '' } = useParams();
  const [lookup, setLookup] = useState('');
  const [sponsored, setSponsored] = useState(false);
  const navigate = useNavigate();
  const transactions = useTransactions(wallet.address, wallet.network, { sponsored, contractId });
  const passphrase = wallet.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  const rpcUrl = escrowRpcUrl(passphrase);
  if (page === 'history')
    return <History walletState={wallet.walletState} publicKey={wallet.address} />;
  return (
    <main>
      <h1>
        {page === 'create'
          ? 'Create match'
          : page === 'deposit'
            ? 'Deposit stake'
            : 'Match details'}
      </h1>
      {!wallet.address && <button onClick={wallet.connect}>Connect wallet</button>}
      <label>
        <input
          type="checkbox"
          checked={sponsored}
          onChange={(e) => setSponsored(e.target.checked)}
        />
        Request testnet fee sponsorship
      </label>
      {!contractId && <p role="alert">No escrow contract configured.</p>}
      {page === 'create' ? (
        <CreateMatch
          contractId={contractId}
          player1Address={wallet.address}
          networkPassphrase={passphrase}
          rpcUrl={rpcUrl}
          onCreateMatch={async (data) => {
            const id = await transactions.handleCreateMatch(data);
            navigate(`/matches/${id}`);
            return id;
          }}
        />
      ) : !matchId ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (/^\d+$/.test(lookup))
              navigate(page === 'deposit' ? `/matches/${lookup}/deposit` : `/matches/${lookup}`);
          }}
        >
          <label>
            Match ID
            <input
              required
              pattern="[0-9]+"
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
            />
          </label>
          <button>Find match</button>
        </form>
      ) : !/^\d+$/.test(matchId) ? (
        <p role="alert">Invalid match ID</p>
      ) : (
        <>
          <Link to={`/matches/${matchId}`}>Match details</Link>{' '}
          <Link to={`/matches/${matchId}/deposit`}>Deposit stake</Link>
          {page === 'deposit' ? (
            <DepositStake
              matchId={matchId}
              contractId={contractId}
              playerAddress={wallet.address}
              networkPassphrase={passphrase}
              rpcUrl={rpcUrl}
              onDeposit={transactions.handleDeposit}
            />
          ) : (
            <MatchStatus
              matchId={matchId}
              contractId={contractId}
              networkPassphrase={passphrase}
              rpcUrl={rpcUrl}
              onFetchMatch={(id) => fetchMatchStatus(id, contractId, passphrase, wallet.address)}
            />
          )}
        </>
      )}
    </main>
  );
}
