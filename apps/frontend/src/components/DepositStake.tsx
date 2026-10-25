import React, { useState, useEffect, useCallback } from 'react';
import {
  Account,
  Asset,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';
import type { xdr } from '@stellar/stellar-sdk';
import { TransactionStatus } from './TransactionStatus';
import { APP_NETWORK_CONFIG } from '../config/network';
import { EligibilityNotice } from './EligibilityNotice';

type DepositStatus = 'idle' | 'loading' | 'pending' | 'success' | 'error' | 'approving';
type AllowanceStatus = 'unknown' | 'checking' | 'sufficient' | 'insufficient';

/** Average Stellar ledger close time in seconds. */
const LEDGER_CLOSE_SECS = 5;

/**
 * Compute how many seconds remain before the match times out.
 *
 * @param createdLedger    The ledger at which the match was created.
 * @param timeoutLedgers   The number of ledgers until timeout.
 * @param currentLedger    The current ledger number.
 * @param elapsedSeconds   Real-time seconds elapsed since the data was fetched.
 * @returns Remaining seconds (>= 0); returns 0 when the timeout has already passed.
 */
function computeTimeoutSecondsRemaining(
  createdLedger: number,
  timeoutLedgers: number,
  currentLedger: number,
  elapsedSeconds: number,
): number {
  const expirationLedger = createdLedger + timeoutLedgers;
  const ledgersRemaining = expirationLedger - currentLedger;
  const secondsFromLedgers = ledgersRemaining * LEDGER_CLOSE_SECS;
  return Math.max(0, secondsFromLedgers - elapsedSeconds);
}

/** Format a duration given in seconds into a human-readable string. */
function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'Expired';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

interface MatchDetails {
  stakeAmount: string;
  token: string;
  player1: string;
  player2: string;
  player1Deposited: boolean;
  player2Deposited: boolean;
  createdLedger: number;
  timeoutLedgers: number;
  currentLedger: number;
}

/**
 * Fetch a match record from the deployed EscrowContract via Soroban RPC and
 * map it to the shape the UI renders.
 *
 * `get_match` is a read-only view, so we simulate the invocation — no wallet
 * signature or transaction submission is required. The simulation source only
 * needs to exist as an account on the ledger; the deployed contract address is
 * used so this works even before the user connects a wallet.
 */
async function fetchMatchFromEscrow({
  matchId,
  contractId,
  rpcUrl,
  networkPassphrase,
}: {
  matchId: string;
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}): Promise<MatchDetails> {
  if (!/^\d+$/.test(matchId)) {
    throw new Error('Invalid match ID');
  }

  const server = new rpc.Server(rpcUrl);
  const source = new Account(contractId, '0');

  const tx = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'get_match',
        args: [nativeToScVal(BigInt(matchId), { type: 'u64' })],
      }),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);

  if ('error' in sim) {
    throw new Error(
      `Could not load match ${matchId}: the escrow contract returned an error (${sim.error})`,
    );
  }
  if (!sim.result?.retval) {
    throw new Error(`Could not load match ${matchId}: the RPC server returned no result`);
  }

  return deserializeMatch(sim.result.retval, networkPassphrase, rpcUrl);
}

/** Convert the ScVal returned by `get_match` into the UI's MatchDetails shape. */
async function deserializeMatch(
  returnValue: xdr.ScVal,
  networkPassphrase: string,
  rpcUrl: string,
): Promise<MatchDetails> {
  const raw = (scValToNative(returnValue) ?? {}) as Record<string, unknown>;

  if (
    (typeof raw.stake_amount !== 'bigint' && typeof raw.stake_amount !== 'number') ||
    typeof raw.player1 !== 'string' ||
    typeof raw.player2 !== 'string'
  ) {
    throw new Error('Unexpected response from EscrowContract.get_match');
  }

  const tokenAddress = typeof raw.token === 'string' ? raw.token : '';
  // The contract stores the native XLM asset as its Soroban contract address;
  // map it back to the symbol the UI already understands.
  const nativeTokenAddress = Asset.native().contractId(networkPassphrase);

  // Get created_ledger and timeout_ledgers from the response, or use defaults for testing
  const createdLedger =
    typeof raw.created_ledger === 'bigint' || typeof raw.created_ledger === 'number'
      ? Number(raw.created_ledger)
      : 0;
  const timeoutLedgers =
    typeof raw.timeout_ledgers === 'bigint' || typeof raw.timeout_ledgers === 'number'
      ? Number(raw.timeout_ledgers)
      : 120_960; // Default TIMEOUT_LEDGERS from contract

  // Fetch current ledger height from RPC
  const server = new rpc.Server(rpcUrl);
  const ledgerResponse = await server.getLedgers().order('desc').limit(1).call();
  const currentLedger = parseInt(ledgerResponse.records[0].sequence, 10);

  return {
    stakeAmount: String(raw.stake_amount),
    token: tokenAddress === nativeTokenAddress ? 'xlm' : tokenAddress,
    player1: raw.player1,
    player2: raw.player2,
    player1Deposited: Boolean(raw.player1_deposited),
    player2Deposited: Boolean(raw.player2_deposited),
    createdLedger,
    timeoutLedgers,
    currentLedger,
  };
}

interface DepositStakeProps {
  matchId: string;
  playerAddress: string | null;
  contractId: string;
  networkPassphrase?: string;
  rpcUrl?: string;
  onDeposit?: (matchId: string) => Promise<void>;
  /** Called when the user clicks 'Approve Token'. Should submit an approve/allowance tx. */
  onApprove?: (matchId: string) => Promise<void>;
  /** Optional: externally supply allowance status to skip the internal check. */
  allowanceSufficient?: boolean | null;
  /** Optional: externally supply allowance check function. */
  checkAllowance?: (playerAddress: string, contractId: string) => Promise<boolean>;
}

export function DepositStake({
  matchId,
  playerAddress,
  contractId,
  networkPassphrase = APP_NETWORK_CONFIG.networkPassphrase,
  rpcUrl = APP_NETWORK_CONFIG.rpcUrl,
  onDeposit,
  onApprove,
  allowanceSufficient = null,
  checkAllowance,
}: DepositStakeProps) {
  const [matchDetails, setMatchDetails] = useState<MatchDetails | null>(null);
  const [status, setStatus] = useState<DepositStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [allowanceStatus, setAllowanceStatus] = useState<AllowanceStatus>('unknown');
  /**
   * Wall-clock seconds elapsed since matchDetails was last set.
   * Used to advance the timeout countdown without requiring another RPC
   * round-trip every second.
   */
  const [elapsedSecs, setElapsedSecs] = useState(0);

  const hasDeposited = (matchDetails: MatchDetails | null): boolean => {
    if (!matchDetails || !playerAddress) return false;
    // Identify which player is acting by comparing against the stored addresses,
    // then check only that player's deposit flag. Otherwise a player's deposit
    // would incorrectly disable the other player's deposit button.
    if (matchDetails.player1 === playerAddress) {
      return matchDetails.player1Deposited;
    }
    if (matchDetails.player2 === playerAddress) {
      return matchDetails.player2Deposited;
    }
    return false;
  };

  const fetchMatchDetails = useCallback(async () => {
    if (!matchId || !contractId) return;

    setStatus('loading');
    try {
      const details = await fetchMatchFromEscrow({
        matchId,
        contractId,
        rpcUrl,
        networkPassphrase,
      });
      setMatchDetails(details);
      // Reset the elapsed-seconds counter whenever we get fresh data so the
      // countdown stays in sync with the on-chain ledger estimate.
      setElapsedSecs(0);
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to fetch match details');
    }
  }, [matchId, contractId, rpcUrl, networkPassphrase]);

  useEffect(() => {
    fetchMatchDetails();
  }, [fetchMatchDetails]);

  // Sync externally-supplied allowance status when the prop changes
  useEffect(() => {
    if (allowanceSufficient === null) return;
    setAllowanceStatus(allowanceSufficient ? 'sufficient' : 'insufficient');
  }, [allowanceSufficient]);

  // Run the internal allowance check whenever the player or contract changes
  const verifyAllowance = useCallback(async () => {
    if (!playerAddress || !contractId) return;

    // If a custom checker was provided, use it; otherwise default to sufficient
    // (XLM is a native asset with no ERC-20-style allowance requirement)
    if (checkAllowance) {
      setAllowanceStatus('checking');
      try {
        const ok = await checkAllowance(playerAddress, contractId);
        setAllowanceStatus(ok ? 'sufficient' : 'insufficient');
      } catch {
        // On error, default to sufficient so the deposit button stays usable
        setAllowanceStatus('sufficient');
      }
    } else {
      // No checker supplied — XLM native tokens do not require approval
      setAllowanceStatus('sufficient');
    }
  }, [playerAddress, contractId, checkAllowance]);

  useEffect(() => {
    if (allowanceSufficient !== null) return; // Controlled externally
    verifyAllowance();
  }, [allowanceSufficient, verifyAllowance]);

  // Advance the countdown timer every second to keep it in sync with wall-clock time
  useEffect(() => {
    if (!matchDetails) return;

    const interval = setInterval(() => {
      setElapsedSecs((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [matchDetails]);

  const handleApprove = useCallback(async () => {
    if (!matchId) return;

    setStatus('approving');
    setErrorMsg('');

    try {
      await onApprove?.(matchId);
      // Re-check allowance after approval
      await verifyAllowance();
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Approval transaction failed');
    }
  }, [matchId, onApprove, verifyAllowance]);

  const handleDeposit = useCallback(async () => {
    if (!matchId) return;

    setStatus('pending');
    setErrorMsg('');
    setTxHash(null);

    try {
      await onDeposit?.(matchId);
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Deposit transaction failed');
    }
  }, [matchId, onDeposit]);

  const isLoading = status === 'loading';
  const isPending = status === 'pending';
  const isApproving = status === 'approving';
  const isCheckingAllowance = allowanceStatus === 'checking';
  const needsApproval = allowanceStatus === 'insufficient';

  // Compute time remaining before match timeout
  const timeoutSecondsRemaining =
    matchDetails && matchDetails.createdLedger && matchDetails.timeoutLedgers
      ? computeTimeoutSecondsRemaining(
          matchDetails.createdLedger,
          matchDetails.timeoutLedgers,
          matchDetails.currentLedger,
          elapsedSecs,
        )
      : null;

  const isExpired = timeoutSecondsRemaining !== null && timeoutSecondsRemaining === 0;

  // Deposit button is disabled when: loading match data, tx already in flight,
  // player already deposited, allowance is still being checked, allowance is
  // insufficient, or timeout has expired. The isPending guard is the critical one — without it the user
  // can click twice and submit duplicate transactions.
  const isDisabled =
    isLoading || isPending || hasDeposited(matchDetails) || isCheckingAllowance || needsApproval || isExpired;

  // Loading state
  if (isLoading && !matchDetails) {
    return (
      <div className="deposit-stake" data-testid="deposit-stake">
        <div className="spinner" />
        <p className="loading-message">Loading match details…</p>
      </div>
    );
  }

  // Error loading match
  if (status === 'error' && !matchDetails) {
    return (
      <div className="deposit-stake" data-testid="deposit-stake">
        <p className="feedback error" role="alert" data-testid="deposit-error">
          {errorMsg}
        </p>
        <button
          type="button"
          className="btn btn-retry"
          onClick={fetchMatchDetails}
          data-testid="retry-btn"
        >
          Retry
        </button>
      </div>
    );
  }

  // No match ID provided
  if (!matchId) {
    return null;
  }

  return (
    <div className="deposit-stake" data-testid="deposit-stake">
      <h3 className="deposit-title">Deposit Stake</h3>
      <EligibilityNotice />

      {matchDetails && (
        <div className="match-info" data-testid="match-info">
          <p>
            <span className="match-info-label">Stake Amount:</span>{' '}
            <strong>{matchDetails.stakeAmount}</strong> {matchDetails.token.toUpperCase()}
          </p>
          <p>
            <span className="match-info-label">Player 1:</span>{' '}
            <span className="address">
              {matchDetails.player1.slice(0, 4)}...{matchDetails.player1.slice(-4)}
            </span>
            <span
              className={`status-indicator ${matchDetails.player1Deposited ? 'deposited' : 'pending'}`}
              data-testid="player1-status"
            >
              {matchDetails.player1Deposited ? '✓ Deposited' : 'Pending'}
            </span>
          </p>
          <p>
            <span className="match-info-label">Player 2:</span>{' '}
            <span className="address">
              {matchDetails.player2.slice(0, 4)}...{matchDetails.player2.slice(-4)}
            </span>
            <span
              className={`status-indicator ${matchDetails.player2Deposited ? 'deposited' : 'pending'}`}
              data-testid="player2-status"
            >
              {matchDetails.player2Deposited ? '✓ Deposited' : 'Pending'}
            </span>
          </p>
          {timeoutSecondsRemaining !== null && (
            <p className="timeout-countdown" data-testid="timeout-countdown">
              <span className="timeout-label">Time to deposit:</span>{' '}
              <strong className={isExpired ? 'expired' : ''}>{formatDuration(timeoutSecondsRemaining)}</strong>
            </p>
          )}
        </div>
      )}

      {/* Allowance check banner */}
      {isCheckingAllowance && (
        <p
          className="feedback info"
          role="status"
          data-testid="allowance-checking"
          aria-live="polite"
        >
          Checking token allowance…
        </p>
      )}

      {/* Approve button — shown when the escrow contract lacks spending permission */}
      {needsApproval && !hasDeposited(matchDetails) && (
        <>
          <p
            className="feedback warning"
            role="note"
            data-testid="allowance-warning"
            aria-live="polite"
          >
            The escrow contract is not approved to spend your tokens. Approve it first, then
            deposit.
          </p>
          <button
            type="button"
            className="btn btn-approve"
            onClick={handleApprove}
            disabled={isApproving || isLoading}
            data-testid="approve-btn"
            aria-busy={isApproving}
          >
            {isApproving ? 'Approving…' : 'Approve Token'}
          </button>
        </>
      )}

      {/* Match timeout expired */}
      {isExpired && (
        <p
          className="feedback error"
          role="alert"
          data-testid="timeout-expired"
          aria-live="polite"
        >
          Match deposit window has expired. No further deposits are allowed.
        </p>
      )}

      <button
        type="button"
        className="btn btn-deposit"
        onClick={handleDeposit}
        disabled={isDisabled}
        data-testid="deposit-btn"
        aria-busy={isPending}
      >
        {isPending
          ? 'Depositing…'
          : hasDeposited(matchDetails)
            ? 'Already Deposited'
            : isCheckingAllowance
              ? 'Checking allowance…'
              : isExpired
                ? 'Deposit Window Expired'
                : 'Deposit Stake'}
      </button>

      {/* Transaction status with aria-live announcements */}
      <TransactionStatus
        status={status === 'loading' ? 'idle' : (status as any)}
        pendingMessage="Depositing stake…"
        successMessage="Deposit successful!"
        errorMessage={errorMsg}
        txHash={txHash}
        testId="deposit-status"
        className="mt-4"
      />
    </div>
  );
}

export default DepositStake;
