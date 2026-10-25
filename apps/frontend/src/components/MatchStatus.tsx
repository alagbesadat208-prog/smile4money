import React, { useState, useEffect, useCallback } from 'react';
import { rpc } from '@stellar/stellar-sdk';
import { DISPUTE_WINDOW_LEDGERS, SECONDS_PER_LEDGER } from '../constants';
import { APP_NETWORK_CONFIG } from '../config/network';

type MatchState = 'Pending' | 'Active' | 'PendingResult' | 'Completed' | 'Cancelled';

/** Reason a match entered the Cancelled terminal state. */
type CancellationReason = 'cancelled_by_player' | 'timed_out';

interface MatchData {
  id: string;
  state: MatchState;
  player1: string;
  player2: string;
  stakeAmount: string;
  token: string;
  platform: 'lichess' | 'chesscom';
  gameId: string;
  winner?: 'Player1' | 'Player2' | 'Draw';
  /** Which player cancelled the match (Stellar address), if applicable. */
  cancelledBy?: string;
  /** How the match was cancelled: by a player or via the timeout mechanism. */
  cancellationReason?: CancellationReason;
  /** Whether player1 had already deposited before cancellation. */
  player1Deposited?: boolean;
  /** Whether player2 had already deposited before cancellation. */
  player2Deposited?: boolean;
  /**
   * The ledger sequence number at which `submit_result` was called.
   * Set when state is PendingResult; 0 when no result has been submitted.
   */
  pendingResultLedger?: number;
  /**
   * The ledger sequence number at the time this data was fetched.
   * Used together with pendingResultLedger to compute the dispute countdown.
   */
  currentLedger?: number;
}

interface MatchStatusProps {
  matchId: string;
  contractId?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  onFetchMatch?: (matchId: string) => Promise<MatchData | null>;
}

type FetchStatus = 'idle' | 'loading' | 'error';

const TERMINAL_STATES: MatchState[] = ['Completed', 'Cancelled'];

/**
 * Compute how many seconds remain in the dispute window.
 *
 * @param pendingResultLedger  The ledger at which submit_result was called.
 * @param currentLedger        The ledger number at fetch time.
 * @param elapsedSeconds       Real-time seconds elapsed since the data was fetched.
 * @returns Remaining seconds (>= 0); returns 0 when the window has already closed.
 */
function computeDisputeSecondsRemaining(
  pendingResultLedger: number,
  currentLedger: number,
  elapsedSeconds: number,
): number {
  const ledgersRemaining = pendingResultLedger + DISPUTE_WINDOW_LEDGERS - currentLedger;
  const secondsFromLedgers = ledgersRemaining * SECONDS_PER_LEDGER;
  return Math.max(0, secondsFromLedgers - elapsedSeconds);
}

/** Format a duration given in seconds into a human-readable string. */
function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'Available now';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

export function MatchStatus({
  matchId,
  contractId,
  rpcUrl = APP_NETWORK_CONFIG.rpcUrl,
  networkPassphrase = APP_NETWORK_CONFIG.networkPassphrase,
  onFetchMatch,
}: MatchStatusProps) {
  const [matchData, setMatchData] = useState<MatchData | null>(null);
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  /**
   * Wall-clock seconds elapsed since matchData was last set.
   * Used to advance the dispute-window countdown without requiring another RPC
   * round-trip every second.
   */
  const [elapsedSecs, setElapsedSecs] = useState(0);

  const fetchMatch = useCallback(async () => {
    if (!matchId) return;

    try {
      const data = await onFetchMatch?.(matchId);
      if (data) {
        setMatchData(data);
        // Reset the elapsed-seconds counter whenever we get fresh data so the
        // countdown stays in sync with the on-chain ledger estimate.
        setElapsedSecs(0);
      }
      setFetchStatus('idle');
    } catch (err) {
      setFetchStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Failed to fetch match status');
    }
  }, [matchId, onFetchMatch]);

  // Track latest match state in a ref so the polling interval can read it
  // without being recreated on every data update.
  const matchDataRef = React.useRef<MatchData | null>(null);
  useEffect(() => {
    matchDataRef.current = matchData;
  }, [matchData]);

  useEffect(() => {
    if (!matchId) return;

    // Initial fetch on mount / matchId change
    setFetchStatus('loading');
    fetchMatch();

    // Poll every 10 seconds; stop automatically when a terminal state is reached.
    // The interval is intentionally NOT re-created when matchData changes — we
    // read the latest value through matchDataRef inside the callback instead.
    const interval = setInterval(() => {
      if (
        matchDataRef.current &&
        TERMINAL_STATES.includes(matchDataRef.current.state)
      ) {
        clearInterval(interval);
        return;
      }
      fetchMatch();
    }, 10_000);

    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, fetchMatch]);

  // Tick every second while in PendingResult to keep the countdown live.
  // The ticker is intentionally separate from the polling interval so it can
  // run at 1 s resolution without hammering the RPC every second.
  useEffect(() => {
    if (matchData?.state !== 'PendingResult') return;
    const ticker = setInterval(() => {
      setElapsedSecs((s) => s + 1);
    }, 1000);
    return () => clearInterval(ticker);
  }, [matchData?.state]);

  // No match ID
  if (!matchId) {
    return (
      <div className="match-status" data-testid="match-status">
        <p className="no-match-message">Enter a match ID to view status</p>
      </div>
    );
  }

  // Loading state — animate-pulse skeleton matching the loaded match card layout
  if (fetchStatus === 'loading' && !matchData) {
    return (
      <div className="match-status animate-pulse" data-testid="match-status-skeleton" aria-busy="true" aria-label="Loading match status">
        {/* Title bar */}
        <div className="mb-3 h-6 w-32 rounded bg-slate-200 dark:bg-slate-700" />
        {/* Match ID line */}
        <div className="mb-4 h-4 w-48 rounded bg-slate-200 dark:bg-slate-700" />
        {/* State content block */}
        <div className="space-y-2 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div className="h-5 w-24 rounded bg-slate-200 dark:bg-slate-700" />
          <div className="h-4 w-full rounded bg-slate-200 dark:bg-slate-700" />
          <div className="h-4 w-3/4 rounded bg-slate-200 dark:bg-slate-700" />
        </div>
      </div>
    );
  }

  // Error state
  if (fetchStatus === 'error' && !matchData) {
    return (
      <div className="match-status" data-testid="match-status">
        <p className="feedback error" role="alert" data-testid="match-error">
          {errorMessage}
        </p>
        <button
          type="button"
          className="btn btn-retry"
          onClick={() => setFetchStatus('loading')}
          data-testid="retry-match-btn"
        >
          Retry
        </button>
      </div>
    );
  }

  // No match found
  if (!matchData) {
    return (
      <div className="match-status" data-testid="match-status">
        <p className="feedback error" role="alert" data-testid="match-not-found">
          Match not found
        </p>
      </div>
    );
  }

  const renderStateContent = () => {
    switch (matchData.state) {
      case 'Pending':
        const p1Deposited = matchData.player1 ? '✓' : '○';
        const p2Deposited = matchData.player2 ? '✓' : '○';
        return (
          <div className="state-content pending" data-testid="state-pending">
            <h3 className="state-title">Pending</h3>
            <p className="state-description">Waiting for both players to deposit their stakes.</p>
            <div className="deposit-status" data-testid="deposit-status">
              <span className="deposit-status-row">
                <span className="match-info-label">Player 1:</span> {p1Deposited}{' '}
                {matchData.player1 && (
                  <span className="address-small">
                    ({matchData.player1.slice(0, 4)}...{matchData.player1.slice(-4)})
                  </span>
                )}
              </span>
              <span className="deposit-status-row">
                <span className="match-info-label">Player 2:</span>{' '}
                {matchData.player2 && (
                  <span className="address-small">
                    ({matchData.player2.slice(0, 4)}...{matchData.player2.slice(-4)})
                  </span>
                )}
                {p2Deposited}
              </span>
            </div>
          </div>
        );

      case 'Active':
        return (
          <div className="state-content active" data-testid="state-active">
            <h3 className="state-title">Active</h3>
            <p className="state-description">
              Game is in progress on {matchData.platform === 'lichess' ? 'Lichess' : 'Chess.com'}.
              Game ID: {matchData.gameId}
            </p>
            <p className="waiting-oracle">Waiting for oracle to submit result…</p>
          </div>
        );

      case 'PendingResult': {
        // Compute dispute window countdown from on-chain ledger data when available.
        let countdownEl: React.ReactNode = null;
        if (
          matchData.pendingResultLedger !== undefined &&
          matchData.pendingResultLedger > 0 &&
          matchData.currentLedger !== undefined &&
          matchData.currentLedger > 0
        ) {
          const secsRemaining = computeDisputeSecondsRemaining(
            matchData.pendingResultLedger,
            matchData.currentLedger,
            elapsedSecs,
          );
          const isAvailable = secsRemaining <= 0;
          countdownEl = (
            <p
              className={`dispute-countdown ${isAvailable ? 'available' : 'pending'}`}
              data-testid="dispute-countdown"
              aria-live="polite"
            >
              {isAvailable ? (
                <>Payout available — <strong>finalize_result can be called now</strong></>
              ) : (
                <>
                  Payout available in{' '}
                  <strong data-testid="dispute-countdown-value">
                    ~{formatDuration(secsRemaining)}
                  </strong>
                </>
              )}
            </p>
          );
        }

        return (
          <div className="state-content pending-result" data-testid="state-pending-result">
            <h3 className="state-title">Result Pending</h3>
            <p className="state-description">
              Oracle has submitted a result. Dispute window is open.
            </p>
            {matchData.winner && (
              <p className="winner-info">
                Reported winner:{' '}
                <strong>
                  {matchData.winner === 'Player1'
                    ? 'Player 1'
                    : matchData.winner === 'Player2'
                      ? 'Player 2'
                      : 'Draw'}
                </strong>
              </p>
            )}
            {countdownEl}
          </div>
        );
      }

      case 'Completed':
        if (!matchData.winner) {
          return (
            <div className="state-content completed" data-testid="state-completed">
              <h3 className="state-title">Completed</h3>
              <p className="state-description">Match completed.</p>
            </div>
          );
        }
        return (
          <div className="state-content completed" data-testid="state-completed">
            <h3 className="state-title">Completed</h3>
            <p className="state-description">
              {matchData.winner === 'Draw'
                ? 'The match ended in a draw. Stakes have been returned to both players.'
                : `Winner: ${matchData.winner === 'Player1' ? 'Player 1' : 'Player 2'}. Prize of ${matchData.stakeAmount} ${matchData.token.toUpperCase()} has been paid out.`}
            </p>
          </div>
        );

      case 'Cancelled': {
        const isTimedOut = matchData.cancellationReason === 'timed_out';
        const cancelledByAddress = matchData.cancelledBy;

        let cancellationDetail: string;
        if (isTimedOut) {
          cancellationDetail =
            'The match timed out because the oracle did not submit a result within the allowed window.';
        } else if (cancelledByAddress) {
          const isP1 = cancelledByAddress === matchData.player1;
          const canceller = isP1 ? 'Player 1' : 'Player 2';
          cancellationDetail = `This match was cancelled by ${canceller} (${cancelledByAddress.slice(0, 4)}...${cancelledByAddress.slice(-4)}).`;
        } else {
          cancellationDetail = 'This match has been cancelled.';
        }

        const p1Refunded = matchData.player1Deposited ?? false;
        const p2Refunded = matchData.player2Deposited ?? false;
        const anyRefund = p1Refunded || p2Refunded;

        return (
          <div className="state-content cancelled" data-testid="state-cancelled">
            <h3 className="state-title">Cancelled</h3>
            <p
              className="state-description"
              data-testid={isTimedOut ? 'cancel-reason-timeout' : 'cancel-reason-player'}
            >
              {cancellationDetail}
            </p>
            {anyRefund && (
              <div className="refund-info" data-testid="refund-info">
                <p className="refund-title">Refunds issued:</p>
                <ul className="refund-list">
                  {p1Refunded && (
                    <li data-testid="refund-player1">
                      Player 1 refunded {matchData.stakeAmount} {matchData.token.toUpperCase()}
                    </li>
                  )}
                  {p2Refunded && (
                    <li data-testid="refund-player2">
                      Player 2 refunded {matchData.stakeAmount} {matchData.token.toUpperCase()}
                    </li>
                  )}
                </ul>
              </div>
            )}
            {!anyRefund && (
              <p className="no-refund" data-testid="no-refund-info">
                No stakes were deposited; no refunds were necessary.
              </p>
            )}
          </div>
        );
      }
    }
  };

  return (
    <div className="match-status" data-testid="match-status">
      <h2 className="match-status-title">Match Status</h2>
      <div className="match-id-display" data-testid="match-id-display">
        Match ID: <strong>{matchData.id}</strong>
      </div>
      {fetchStatus === 'error' && (
        <div className="feedback warning" role="alert" data-testid="match-refresh-warning">
          <span>Unable to refresh — showing last known state.</span>{' '}
          <button type="button" className="btn btn-retry" onClick={fetchMatch}>
            Retry?
          </button>
        </div>
      )}
      {renderStateContent()}
    </div>
  );
}

export default MatchStatus;
