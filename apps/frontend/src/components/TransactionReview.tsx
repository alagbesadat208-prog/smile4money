import React, { useEffect, useRef, useCallback } from 'react';
import type { TransactionReviewSummary } from '../hooks/useTransactions';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface TransactionReviewProps {
  summary: TransactionReviewSummary;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** While true the confirm button is disabled and shows a loading label. */
  isConfirming?: boolean;
  /** Set when the confirm action failed; shown inside the dialog so the user
   *  can correct the input or retry instead of losing context. */
  errorMessage?: string;
}

export function TransactionReview({
  summary,
  onConfirm,
  onCancel,
  isConfirming = false,
  errorMessage,
}: TransactionReviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus trap keeps keyboard navigation inside the dialog while it is open.
  useFocusTrap(containerRef, true);

  // Move focus to the primary (confirm) action when the review opens.
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    },
    [onCancel],
  );

  const handleConfirm = useCallback(async () => {
    await onConfirm();
  }, [onConfirm]);

  return (
    <div
      ref={containerRef}
      className="transaction-review dark:bg-slate-800 dark:border-slate-700 rounded-lg border border-slate-200 bg-white p-6 shadow-lg text-slate-900 dark:text-slate-100"
      data-testid="transaction-review"
      role="dialog"
      aria-modal="true"
      aria-labelledby="transaction-review-title"
      aria-label="Review transaction before signing"
      onKeyDown={handleKeyDown}
    >
      <h2 id="transaction-review-title" className="mb-4 text-lg font-semibold">
        Review before signing
      </h2>

      {errorMessage && (
        <p
          className="mb-4 text-sm font-medium text-red-600 dark:text-red-400"
          role="alert"
          data-testid="transaction-review-error"
        >
          {errorMessage}
        </p>
      )}

      <dl className="mb-6 space-y-2 text-sm" data-testid="transaction-review-summary">
        <div className="flex justify-between border-b pb-1 last:border-0">
          <dt className="font-medium text-slate-600 dark:text-slate-300">Opponent</dt>
          <dd className="font-mono">{summary.opponent}</dd>
        </div>
        <div className="flex justify-between border-b pb-1 last:border-0">
          <dt className="font-medium text-slate-600 dark:text-slate-300">Asset</dt>
          <dd>{summary.asset}</dd>
        </div>
        <div className="flex justify-between border-b pb-1 last:border-0">
          <dt className="font-medium text-slate-600 dark:text-slate-300">Stake</dt>
          <dd>{summary.stake}</dd>
        </div>
        <div className="flex justify-between border-b pb-1 last:border-0">
          <dt className="font-medium text-slate-600 dark:text-slate-300">Network</dt>
          <dd>{summary.network}</dd>
        </div>
        <div className="flex justify-between border-b pb-1 last:border-0">
          <dt className="font-medium text-slate-600 dark:text-slate-300">Contract action</dt>
          <dd>{summary.action}</dd>
        </div>
      </dl>

      <div className="grid grid-cols-2 gap-3">
        <button
          ref={cancelRef}
          type="button"
          className="btn btn-cancel focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
          onClick={onCancel}
          data-testid="review-cancel-btn"
        >
          Cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          className={`btn btn-submit focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2`}
          disabled={isConfirming}
          onClick={handleConfirm}
          data-testid="review-confirm-btn"
        >
          {isConfirming ? 'Signing…' : 'Confirm &amp; Sign'}
        </button>
      </div>
    </div>
  );
}

export default TransactionReview;
