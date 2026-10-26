import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { WalletStatus, Network } from '../types';
import { useToast } from './Toast';
import { TransactionStatus } from './TransactionStatus';

type Mode = 'claim' | 'burn';
type Status = 'idle' | 'simulating' | 'confirm' | 'pending' | 'success' | 'error';

export interface TransactionSimulationResponse {
  minResourceFee?: string;
  error?: string;
}

export interface ConfirmedTransaction {
  hash: string;
  confirmed: true;
}

export interface ClaimBurnProps {
  walletState: WalletStatus;
  onConnect?: () => void;
  onClaim?: (amount: string) => Promise<ConfirmedTransaction | void>;
  onBurn?: (amount: string) => Promise<ConfirmedTransaction | void>;
  onSimulateTransaction?: (mode: Mode, amount: string) => Promise<TransactionSimulationResponse>;
  onSwitchNetwork?: () => void;
  onDisconnect?: () => void;
  onRefreshBalance?: () => void;
  publicKey?: string | null;
  balance?: string | null;
  expectedNetwork?: string;
  tokenSymbol?: string;
  /** Current wallet network — used to build Stellar Expert explorer links. */
  network?: Network;
}

function isValidAmount(value: string): boolean {
  const n = Number(value);
  return value.trim() !== '' && !isNaN(n) && n > 0;
}

function formatStroopsAsXlm(stroops: string): string {
  const wholeXlm = stroops.slice(0, -7) || '0';
  const fractionalXlm = stroops.slice(-7).padStart(7, '0').replace(/0+$/, '');
  return fractionalXlm ? `${wholeXlm}.${fractionalXlm}` : wholeXlm;
}

export function ClaimBurn({
  walletState,
  onConnect,
  onClaim,
  onBurn,
  onSimulateTransaction,
  onSwitchNetwork,
  onDisconnect,
  onRefreshBalance,
  publicKey,
  balance,
  expectedNetwork = 'testnet',
  tokenSymbol = 'XLM',
  network = 'unknown',
}: ClaimBurnProps) {
  const [mode, setMode] = useState<Mode>('claim');
  const [inputAmount, setInputAmount] = useState('');
  const [confirmAmount, setConfirmAmount] = useState('');
  const [estimatedFee, setEstimatedFee] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);

  const amountInputRef = useRef<HTMLInputElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const toast = useToast();

  // Auto-dismiss success after 3s
  useEffect(() => {
    if (status === 'success') {
      const t = setTimeout(() => setStatus('idle'), 3000);
      return () => clearTimeout(t);
    }
  }, [status]);

  // Focus confirm button when overlay appears
  useEffect(() => {
    if (status === 'confirm') {
      confirmBtnRef.current?.focus();
    }
  }, [status]);

  // Synchronize account changes: reset pending/confirming actions if account changes
  const prevPublicKeyRef = useRef<string | null | undefined>(publicKey);
  useEffect(() => {
    if (
      prevPublicKeyRef.current !== undefined &&
      prevPublicKeyRef.current !== null &&
      prevPublicKeyRef.current !== publicKey
    ) {
      if (status === 'confirm' || status === 'simulating' || status === 'pending') {
        setStatus('error');
        setConfirmAmount('');
        setEstimatedFee(null);
        setErrorMsg('Active wallet account changed. Please re-confirm transaction with the new account.');
      }
    }
    prevPublicKeyRef.current = publicKey;
  }, [publicKey, status]);

  function resetFeedback() {
    setStatus('idle');
    setTxHash(null);
    setErrorMsg('');
    setEstimatedFee(null);
  }

  function handleToggle(newMode: Mode) {
    setMode(newMode);
    resetFeedback();
    setTimeout(() => amountInputRef.current?.focus(), 0);
  }

  function handleAmountChange(e: React.ChangeEvent<HTMLInputElement>) {
    setInputAmount(e.target.value);
    if (status === 'error' || status === 'success') resetFeedback();
  }

  function handleMax() {
    if (balance != null) {
      setInputAmount(balance);
      resetFeedback();
    }
  }

  async function handleRequestSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isBusy) return;
    if (!isValidAmount(inputAmount)) {
      setStatus('error');
      setErrorMsg('Please enter a valid amount greater than 0.');
      setTxHash(null);
      return;
    }
    if (walletState !== 'connected') {
      setStatus('error');
      setErrorMsg('Connect your wallet to continue.');
      setTxHash(null);
      return;
    }
    setStatus('simulating');
    setErrorMsg('');
    setEstimatedFee(null);
    try {
      if (!onSimulateTransaction) {
        throw new Error('Transaction simulation is unavailable.');
      }
      const simulation = await onSimulateTransaction(mode, inputAmount);
      if (simulation.error) {
        throw new Error(simulation.error);
      }
      if (
        typeof simulation.minResourceFee !== 'string' ||
        !/^\d+$/.test(simulation.minResourceFee)
      ) {
        throw new Error('The transaction fee could not be estimated.');
      }
      setConfirmAmount(inputAmount);
      setEstimatedFee(simulation.minResourceFee);
      setStatus('confirm');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'The transaction fee could not be estimated.';
      setStatus('error');
      setErrorMsg(message);
      toast.error('Transaction simulation failed', message);
    }
  }

  const handleConfirm = useCallback(async () => {
    setStatus('pending');
    setErrorMsg('');
    setTxHash(null);
    try {
      const action = mode === 'claim' ? onClaim : onBurn;
      const receipt = await action?.(confirmAmount);
      if (!receipt || receipt.confirmed !== true || !receipt.hash) {
        throw new Error('No confirmed transaction was returned.');
      }
      setTxHash(receipt.hash);
      setStatus('success');
      setInputAmount('');
      toast.success(
        mode === 'claim'
          ? `${tokenSymbol} claimed successfully!`
          : `${tokenSymbol} burned successfully!`,
        `Transaction hash: ${receipt.hash}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      setStatus('error');
      setErrorMsg(message);
      toast.error('Transaction failed', message);
    }
  }, [mode, onClaim, onBurn, confirmAmount, toast, tokenSymbol]);

  function handleCancel() {
    setStatus('idle');
    setConfirmAmount('');
    setTimeout(() => amountInputRef.current?.focus(), 0);
  }

  // Close the confirmation overlay on Escape so keyboard users are never
  // trapped inside the dialog.
  function handleOverlayKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleCancel();
    }
  }

  const isPending = status === 'pending';
  const isBusy = isPending || status === 'simulating';
  const showConfirm = status === 'confirm';
  const valid = isValidAmount(inputAmount);

  // ── Wallet state screens ──────────────────────────────────────────

  if (walletState === 'checking' || walletState === 'connecting') {
    return (
      <div
        className="dark:bg-slate-900 flex flex-col items-center justify-center rounded-xl bg-slate-50 p-10 text-center"
        data-testid="wallet-connecting"
      >
        <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-violet-600 dark:border-slate-700 dark:border-t-violet-400" />
        <p className="dark:text-slate-400 text-sm text-slate-500">Connecting to wallet&hellip;</p>
      </div>
    );
  }

  if (walletState === 'notInstalled') {
    return (
      <div
        className="dark:bg-slate-900 flex flex-col items-center justify-center rounded-xl bg-slate-50 p-10 text-center"
        data-testid="wallet-not-installed"
      >
        <span className="mb-4 text-4xl">⚠️</span>
        <h3 className="dark:text-slate-100 mb-2 text-lg font-semibold text-slate-900">
          Freighter Not Found
        </h3>
        <p className="dark:text-slate-400 mb-4 text-sm text-slate-500">
          Please install the{' '}
          <a
            href="https://freighter.app"
            target="_blank"
            rel="noopener noreferrer"
            className="text-violet-600 underline hover:no-underline dark:text-violet-400"
          >
            Freighter wallet extension
          </a>{' '}
          to continue.
        </p>
      </div>
    );
  }

  if (walletState === 'disconnected') {
    return (
      <div className="claim-burn" data-testid="wallet-disconnected">
        <h2 className="claim-burn-title">Claim &amp; Burn</h2>
        <div className="wallet-state" data-testid="wallet-disconnected-state">
          <span className="wallet-state-icon">💼</span>
          <h3 className="wallet-state-title">Connect Your Wallet</h3>
          <p className="wallet-state-message">
            Connect your Freighter wallet to claim rewards or burn tokens.
          </p>
          <button
            className="btn btn-connect focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            onClick={onConnect}
            data-testid="connect-wallet-btn"
            aria-label="Connect wallet"
          >
            Connect Wallet
          </button>
        </div>
        <form
          onSubmit={handleRequestSubmit}
          data-testid="claim-burn-form"
          aria-label={`${mode === 'claim' ? 'Claim' : 'Burn'} tokens`}
        >
          <div className="form-group">
            <label htmlFor="amount-input">Amount ({tokenSymbol})</label>
            <div className="input-row">
              <input
                ref={amountInputRef}
                id="amount-input"
                type="number"
                min="0"
                step="any"
                value={inputAmount}
                onChange={handleAmountChange}
                disabled
                placeholder="0.00"
                data-testid="amount-input"
                aria-invalid={inputAmount !== '' && !valid}
                aria-label={`${mode === 'claim' ? 'Claim' : 'Burn'} amount`}
                aria-describedby={status === 'error' ? 'claim-burn-error' : undefined}
                className="focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
              />
            </div>
          </div>
          <button
            type="submit"
            className={`btn btn-${mode} focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2`}
            disabled={true}
            data-testid="submit-btn"
            aria-busy={isPending}
            aria-label={`${mode === 'claim' ? 'Claim' : 'Burn'} disabled until wallet is connected`}
          >
            {mode === 'claim' ? 'Claim' : 'Burn'}
          </button>
        </form>
        {status === 'error' && (
          <p className="feedback error" role="alert" data-testid="error-msg" id="claim-burn-error">
            {errorMsg}
          </p>
        )}
      </div>
    );
  }

  if (walletState === 'wrongNetwork') {
    return (
      <div
        className="dark:bg-slate-900 flex flex-col items-center justify-center rounded-xl bg-slate-50 p-10 text-center"
        data-testid="wallet-wrong-network"
      >
        <span className="mb-4 text-4xl">🌐</span>
        <h3 className="dark:text-slate-100 mb-2 text-lg font-semibold text-slate-900">
          Wrong Network
        </h3>
        <p className="dark:text-slate-400 mb-4 text-sm text-slate-500">
          Please switch your Freighter wallet to{' '}
          <strong className="dark:text-slate-200 text-slate-700">{expectedNetwork}</strong>.
        </p>
        <button
          type="button"
          onClick={onSwitchNetwork}
          data-testid="switch-network-btn"
          aria-label={`Switch to ${expectedNetwork} network`}
        >
          Switch to {expectedNetwork}
        </button>
      </div>
    );
  }

  if (walletState === 'error') {
    return (
      <div
        className="dark:bg-slate-900 flex flex-col items-center justify-center rounded-xl bg-slate-50 p-10 text-center"
        data-testid="wallet-error"
      >
        <span className="mb-4 text-4xl">⚠️</span>
        <h3 className="dark:text-slate-100 mb-2 text-lg font-semibold text-slate-900">
          Connection Error
        </h3>
        <p className="dark:text-slate-400 mb-4 text-sm text-slate-500">
          An error occurred while connecting to your wallet.
        </p>
        <button
          type="button"
          onClick={onConnect}
          data-testid="retry-connect-btn"
          aria-label="Retry wallet connection"
        >
          Try Again
        </button>
      </div>
    );
  }

  // ── Connected UI ──────────────────────────────────────────────────

  return (
    <div
      className="dark:bg-slate-900 dark:border-slate-700 w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      data-testid="claim-burn"
    >
      <h2 className="dark:text-slate-100 mb-5 text-center text-xl font-semibold text-slate-900">
        Claim &amp; Burn
      </h2>

      {/* Mode toggle */}
      <div
        className="dark:bg-slate-800 mb-5 flex rounded-lg bg-slate-100 p-1"
        role="group"
        aria-label="Select mode"
      >
        <button
          type="button"
          className={`toggle-btn${mode === 'claim' ? ' active' : ''} focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2`}
          onClick={() => handleToggle('claim')}
          disabled={isBusy}
          aria-pressed={mode === 'claim'}
          data-testid="toggle-claim"
          aria-label="Switch to claim mode"
        >
          Claim
        </button>
        <button
          type="button"
          className={`toggle-btn${mode === 'burn' ? ' active' : ''} focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2`}
          onClick={() => handleToggle('burn')}
          disabled={isBusy}
          aria-pressed={mode === 'burn'}
          data-testid="toggle-burn"
          aria-label="Switch to burn mode"
        >
          Burn
        </button>
      </div>

      {/* Wallet info */}
      {publicKey && (
        <div
          className="dark:bg-slate-800 dark:border-slate-700 mb-4 rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-sm"
          data-testid="wallet-info"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="dark:text-slate-400 font-medium text-slate-600">Connected</span>
            <span className="dark:text-emerald-400 font-mono text-emerald-700 font-semibold">
              {publicKey.slice(0, 4)}&hellip;{publicKey.slice(-4)}
            </span>
            {onDisconnect && (
              <button
                className="btn-disconnect focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                onClick={onDisconnect}
                data-testid="disconnect-btn"
                aria-label="Disconnect wallet"
              >
                Disconnect
              </button>
            )}
          </div>
          {balance != null && (
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-emerald-200 pt-2 dark:border-emerald-800">
              <span className="dark:text-slate-400 font-medium text-slate-600">Balance</span>
              <span
                className="dark:text-emerald-400 font-mono flex-1 text-emerald-700 font-semibold"
                data-testid="wallet-balance"
                aria-label={`${balance} ${tokenSymbol}`}
              >
                {balance} {tokenSymbol}
              </span>
              {onRefreshBalance && (
                <button
                  type="button"
                  onClick={onRefreshBalance}
                  data-testid="refresh-balance-btn"
                  aria-label="Refresh balance"
                  className="rounded-md border border-slate-300 bg-white p-1 text-slate-500 transition-colors hover:text-violet-600 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-400 dark:hover:text-violet-400"
                >
                  ↻
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Confirmation overlay */}
      {showConfirm && (
        <div
          className="dark:bg-slate-800 dark:border-slate-700 mb-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-center"
          data-testid="confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Confirm ${mode}`}
          onKeyDown={handleOverlayKeyDown}
        >
          <p className="dark:text-slate-100 mb-4 text-base font-semibold text-slate-900">
            {mode === 'claim' ? 'Claim' : 'Burn'} <strong>{confirmAmount}</strong> {tokenSymbol}?
          </p>
          {estimatedFee !== null && (
            <p
              className="mb-4 text-sm text-slate-600 dark:text-slate-300"
              data-testid="estimated-fee"
            >
              Estimated fee: <strong>{estimatedFee} stroops</strong> (
              <strong>{formatStroopsAsXlm(estimatedFee)} XLM</strong>)
            </p>
          )}
          {publicKey && (
            <p
              className="mb-4 text-xs text-slate-500 dark:text-slate-400 font-mono"
              data-testid="confirm-active-account"
            >
              Active account: {publicKey.slice(0, 6)}...{publicKey.slice(-6)}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              className="btn btn-cancel focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
              onClick={handleCancel}
              data-testid="cancel-btn"
              aria-label="Cancel confirmation"
            >
              Cancel
            </button>
            <button
              ref={confirmBtnRef}
              type="button"
              className={`btn btn-${mode} focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2`}
              onClick={handleConfirm}
              data-testid="confirm-btn"
              aria-label={`Confirm ${mode}`}
            >
              {isPending ? 'Processing…' : 'Confirm'}
            </button>
          </div>
        </div>
      )}

      {/* Amount form */}
      <form
        onSubmit={handleRequestSubmit}
        data-testid="claim-burn-form"
        aria-label={`${mode === 'claim' ? 'Claim' : 'Burn'} tokens`}
      >
        <div className="mb-1 flex flex-col gap-1.5">
          <label
            htmlFor="amount-input"
            className="dark:text-slate-300 text-sm font-medium text-slate-700"
          >
            Amount ({tokenSymbol})
          </label>
          <div className="flex gap-2">
            <input
              ref={amountInputRef}
              id="amount-input"
              type="text"
              inputMode="decimal"
              pattern="^[0-9]*(?:[.,][0-9]*)?$"
              value={inputAmount}
              onChange={handleAmountChange}
              disabled={isBusy}
              placeholder="0.00"
              data-testid="amount-input"
              aria-invalid={inputAmount !== '' && !valid}
              aria-label={`${mode === 'claim' ? 'Claim' : 'Burn'} amount`}
              aria-describedby={status === 'error' ? 'claim-burn-error' : undefined}
              className="focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            />
            {balance != null && (
              <button
                type="button"
                onClick={handleMax}
                disabled={isBusy}
                data-testid="max-btn"
                aria-label="Use maximum balance"
                className="btn-max dark:bg-slate-800 dark:border-slate-600 dark:text-violet-400 dark:hover:bg-slate-700 shrink-0 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-violet-600 transition-colors hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Max
              </button>
            )}
          </div>
          {inputAmount !== '' && !valid && (
            <p className="text-sm text-red-600 dark:text-red-400" data-testid="amount-error">
              Please enter a valid positive amount
            </p>
          )}
        </div>

        {!showConfirm && (
          <button
            type="submit"
            className={`btn btn-${mode} focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2`}
            disabled={isBusy || !valid || walletState !== 'connected'}
            data-testid="submit-btn"
            aria-busy={isBusy}
            aria-label={`${mode === 'claim' ? 'Claim' : 'Burn'} tokens`}
          >
            {status === 'simulating'
              ? 'Estimating fee…'
              : isPending
                ? mode === 'claim'
                  ? 'Claiming…'
                  : 'Burning…'
                : mode === 'claim'
                  ? 'Claim'
                  : 'Burn'}
          </button>
        )}
      </form>

      {/* Transaction status with aria-live announcements */}
      <TransactionStatus
        status={status === 'simulating' || status === 'confirm' ? 'idle' : status}
        pendingMessage={mode === 'claim' ? 'Claiming tokens…' : 'Burning tokens…'}
        successMessage={
          mode === 'claim'
            ? `${tokenSymbol} claimed successfully!`
            : `${tokenSymbol} burned successfully!`
        }
        errorMessage={errorMsg}
        txHash={txHash}
        testId="claim-burn-status"
        className="mt-4"
        renderTxHashLink={
          txHash
            ? (hash) => (
                <a
                  href={`https://stellar.expert/explorer/${network === 'unknown' ? 'testnet' : network}/tx/${hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="dark:text-blue-300 dark:hover:text-blue-200 break-all font-mono text-xs underline hover:no-underline"
                  data-testid="tx-hash"
                  aria-label={`View transaction ${hash} on Stellar Expert`}
                >
                  {hash.slice(0, 8)}…{hash.slice(-8)} ↗
                </a>
              )
            : undefined
        }
      />
    </div>
  );
}

export default ClaimBurn;
