import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TransactionReview } from '../src/components/TransactionReview';
import type { TransactionReviewSummary } from '../src/hooks/useTransactions';

const summary: TransactionReviewSummary = {
  opponent: 'GA3LQZYOJCAZSMLI47BXMCV2C4SJPZWPLJO7AR76GO56N2QB2DCKTVMV',
  asset: 'XLM (native)',
  stake: '1.5',
  network: 'Testnet',
  action: 'Create match',
};

function renderReview(overrides: Partial<React.ComponentProps<typeof TransactionReview>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <TransactionReview summary={summary} onConfirm={onConfirm} onCancel={onCancel} {...overrides} />,
  );
  return { onConfirm, onCancel };
}

describe('TransactionReview — summary rendering', () => {
  it('displays every review field derived from the submitted arguments', () => {
    renderReview();
    expect(screen.getByTestId('transaction-review')).toBeInTheDocument();
    expect(screen.getByTestId('transaction-review-summary')).toHaveTextContent(
      summary.opponent,
    );
    expect(screen.getByTestId('transaction-review-summary')).toHaveTextContent(summary.asset);
    expect(screen.getByTestId('transaction-review-summary')).toHaveTextContent(summary.stake);
    expect(screen.getByTestId('transaction-review-summary')).toHaveTextContent(summary.network);
    expect(screen.getByTestId('transaction-review-summary')).toHaveTextContent(summary.action);
  });

  it('exposes a dialog role with an accessible name', () => {
    renderReview();
    const dialog = screen.getByTestId('transaction-review');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Review transaction before signing');
  });

  it('announces the review title to assistive technologies', () => {
    renderReview();
    expect(screen.getByText('Review before signing')).toBeInTheDocument();
  });
});

describe('TransactionReview — confirm / cancel', () => {
  it('calls onConfirm when the confirm button is clicked', () => {
    const { onConfirm } = renderReview();
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when the cancel button is clicked', () => {
    const { onCancel } = renderReview();
    fireEvent.click(screen.getByTestId('review-cancel-btn'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('disables the confirm button while signing', () => {
    const { onConfirm } = renderReview({ isConfirming: true });
    expect(screen.getByTestId('review-confirm-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows an error message inside the dialog when the confirm action fails', () => {
    const { onConfirm } = renderReview({ errorMessage: 'Insufficient balance' });
    expect(screen.getByTestId('transaction-review-error')).toHaveTextContent(
      'Insufficient balance',
    );
    // The dialog stays open so the user can recover instead of losing context.
    expect(screen.getByTestId('transaction-review')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe('TransactionReview — keyboard', () => {
  it('moves focus to the confirm button when the review opens', () => {
    renderReview();
    expect(screen.getByTestId('review-confirm-btn')).toHaveFocus();
  });

  it('cancels on Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderReview();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('confirms on Enter (confirm button is focused on open)', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderReview();
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
