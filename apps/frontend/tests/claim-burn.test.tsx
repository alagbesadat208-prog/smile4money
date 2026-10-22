import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ClaimBurn, type ClaimBurnProps } from '../src/components/claim-burn';
import { ToastProvider } from '../src/components/Toast';

function renderWithProviders(ui: React.ReactElement) {
  const element = React.isValidElement<ClaimBurnProps>(ui)
    ? React.cloneElement(ui, {
        onSimulateTransaction:
          ui.props.onSimulateTransaction ?? vi.fn().mockResolvedValue({ minResourceFee: '100' }),
      })
    : ui;
  return render(<ToastProvider>{element}</ToastProvider>);
}

describe('ClaimBurn — wallet states', () => {
  it('shows checking/connecting spinner while loading', () => {
    renderWithProviders(<ClaimBurn walletState="checking" />);
    expect(screen.getByTestId('wallet-connecting')).toBeInTheDocument();
  });

  it('shows connect prompt when disconnected', () => {
    renderWithProviders(<ClaimBurn walletState="disconnected" />);
    expect(screen.getByTestId('wallet-disconnected')).toBeInTheDocument();
    expect(screen.getByTestId('connect-wallet-btn')).toBeInTheDocument();
  });

  it('calls onConnect when connect button clicked', () => {
    const onConnect = vi.fn();
    renderWithProviders(<ClaimBurn walletState="disconnected" onConnect={onConnect} />);
    fireEvent.click(screen.getByTestId('connect-wallet-btn'));
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it('shows connecting state with spinner', () => {
    renderWithProviders(<ClaimBurn walletState="connecting" />);
    expect(screen.getByTestId('wallet-connecting')).toBeInTheDocument();
  });

  it('shows notInstalled state', () => {
    renderWithProviders(<ClaimBurn walletState="notInstalled" />);
    expect(screen.getByTestId('wallet-not-installed')).toBeInTheDocument();
  });

  it('shows wrongNetwork state', () => {
    renderWithProviders(<ClaimBurn walletState="wrongNetwork" expectedNetwork="testnet" />);
    expect(screen.getByTestId('wallet-wrong-network')).toBeInTheDocument();
    expect(screen.getByTestId('switch-network-btn')).toBeInTheDocument();
  });

  it('calls onSwitchNetwork when switch network button clicked', () => {
    const onSwitchNetwork = vi.fn();
    renderWithProviders(<ClaimBurn walletState="wrongNetwork" onSwitchNetwork={onSwitchNetwork} />);
    fireEvent.click(screen.getByTestId('switch-network-btn'));
    expect(onSwitchNetwork).toHaveBeenCalledOnce();
  });

  it('shows form when connected', () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    expect(screen.getByTestId('claim-burn-form')).toBeInTheDocument();
  });

  it('shows wallet info when publicKey provided', () => {
    renderWithProviders(<ClaimBurn walletState="connected" publicKey="GABCDEF1234567890XYZ" />);
    expect(screen.getByTestId('wallet-info')).toBeInTheDocument();
  });
});

describe('ClaimBurn — toggle', () => {
  it('defaults to claim mode', () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    expect(screen.getByTestId('toggle-claim')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('toggle-burn')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('submit-btn')).toHaveTextContent('Claim');
  });

  it('switches to burn mode', () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    fireEvent.click(screen.getByTestId('toggle-burn'));
    expect(screen.getByTestId('toggle-burn')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('toggle-claim')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('submit-btn')).toHaveTextContent('Burn');
  });

  it('switches back to claim mode', () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    fireEvent.click(screen.getByTestId('toggle-burn'));
    fireEvent.click(screen.getByTestId('toggle-claim'));
    expect(screen.getByTestId('toggle-claim')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('submit-btn')).toHaveTextContent('Claim');
  });
});

describe('ClaimBurn — confirmation flow', () => {
  it('shows confirmation overlay after simulating the transaction', async () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('submit-btn'));
    expect(await screen.findByTestId('confirm-overlay')).toBeInTheDocument();
  });

  it('hides submit button when showing confirmation', async () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('submit-btn'));
    await screen.findByTestId('confirm-overlay');
    expect(screen.queryByTestId('submit-btn')).not.toBeInTheDocument();
  });

  it('cancels confirmation and shows submit button again', async () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('submit-btn'));
    await screen.findByTestId('confirm-overlay');
    fireEvent.click(screen.getByTestId('cancel-btn'));
    expect(screen.getByTestId('submit-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('confirm-overlay')).not.toBeInTheDocument();
  });

  it('simulates before confirmation and displays the estimated fee in stroops and XLM', async () => {
    let resolveSimulation!: (response: { minResourceFee: string }) => void;
    const onSimulateTransaction = vi.fn(
      () =>
        new Promise<{ minResourceFee: string }>((resolve) => {
          resolveSimulation = resolve;
        }),
    );
    renderWithProviders(
      <ClaimBurn walletState="connected" onSimulateTransaction={onSimulateTransaction} />,
    );
    await userEvent.type(screen.getByTestId('amount-input'), '10');
    fireEvent.click(screen.getByTestId('submit-btn'));
    await waitFor(() => expect(onSimulateTransaction).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('confirm-overlay')).not.toBeInTheDocument();
    resolveSimulation({ minResourceFee: '12345678' });

    expect(await screen.findByTestId('estimated-fee')).toHaveTextContent(
      'Estimated fee: 12345678 stroops (1.2345678 XLM)',
    );
    expect(onSimulateTransaction).toHaveBeenCalledWith('claim', '10');
  });

  it('shows a simulation error and does not open confirmation when simulation fails', async () => {
    const onSimulateTransaction = vi.fn().mockResolvedValue({ error: 'HostError' });
    const onClaim = vi.fn();
    renderWithProviders(
      <ClaimBurn
        walletState="connected"
        onSimulateTransaction={onSimulateTransaction}
        onClaim={onClaim}
      />,
    );
    await userEvent.type(screen.getByTestId('amount-input'), '10');
    fireEvent.click(screen.getByTestId('submit-btn'));

    expect(await screen.findByTestId('claim-burn-status')).toHaveTextContent('HostError');
    expect(screen.queryByTestId('confirm-overlay')).not.toBeInTheDocument();
    expect(onClaim).not.toHaveBeenCalled();
  });

  it('shows amount in confirmation text', async () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    await userEvent.type(screen.getByTestId('amount-input'), '42.5');
    fireEvent.click(screen.getByTestId('submit-btn'));
    await waitFor(() => expect(screen.getByTestId('confirm-overlay')).toBeInTheDocument());
    expect(screen.getByTestId('confirm-overlay')).toHaveTextContent('42.5');
  });
});

describe('ClaimBurn — submit and error handling', () => {
  it('calls onClaim with entered amount on submit', async () => {
    const onClaim = vi.fn().mockResolvedValue({ hash: 'confirmed-hash', confirmed: true });
    renderWithProviders(<ClaimBurn walletState="connected" onClaim={onClaim} />);
    await userEvent.type(screen.getByTestId('amount-input'), '12.5');
    fireEvent.click(screen.getByTestId('submit-btn'));
    await screen.findByTestId('confirm-overlay');
    fireEvent.click(screen.getByTestId('confirm-btn'));
    await waitFor(() => expect(onClaim).toHaveBeenCalledTimes(1));
    expect(onClaim).toHaveBeenCalledWith('12.5');
  });

  it('disables the submit button when wallet is disconnected', () => {
    renderWithProviders(<ClaimBurn walletState="disconnected" />);
    expect(screen.getByTestId('wallet-disconnected')).toBeInTheDocument();
    expect(screen.getByTestId('submit-btn')).toBeDisabled();
  });

  it('calls onBurn with amount', async () => {
    const onBurn = vi.fn().mockResolvedValue({ hash: 'confirmed-hash', confirmed: true });
    renderWithProviders(<ClaimBurn walletState="connected" onBurn={onBurn} />);
    fireEvent.click(screen.getByTestId('toggle-burn'));
    await userEvent.type(screen.getByTestId('amount-input'), '5');
    fireEvent.click(screen.getByTestId('submit-btn'));
    await screen.findByTestId('confirm-overlay');
    fireEvent.click(screen.getByTestId('confirm-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('claim-burn-status')).toHaveTextContent('burned successfully'),
    );
    expect(onBurn).toHaveBeenCalledWith('5');
  });

  it('does not announce success when an action returns without a confirmed transaction', async () => {
    const onClaim = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<ClaimBurn walletState="connected" onClaim={onClaim} />);
    await userEvent.type(screen.getByTestId('amount-input'), '3');
    fireEvent.click(screen.getByTestId('submit-btn'));
    await screen.findByTestId('confirm-overlay');
    fireEvent.click(screen.getByTestId('confirm-btn'));

    expect(await screen.findByTestId('claim-burn-status')).toHaveTextContent(
      'No confirmed transaction was returned.',
    );
    expect(screen.getByTestId('claim-burn-status')).not.toHaveTextContent('successfully');
  });

  it('shows error on failure', async () => {
    const onClaim = vi.fn().mockRejectedValue(new Error('Transaction failed'));
    renderWithProviders(<ClaimBurn walletState="connected" onClaim={onClaim} />);
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('submit-btn'));
    await screen.findByTestId('confirm-overlay');
    fireEvent.click(screen.getByTestId('confirm-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('claim-burn-status')).toHaveTextContent('Transaction failed'),
    );
  });

  it('resets status on amount change after error', async () => {
    const onClaim = vi.fn().mockRejectedValue(new Error('Transaction failed'));
    renderWithProviders(<ClaimBurn walletState="connected" onClaim={onClaim} />);
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('submit-btn'));
    await screen.findByTestId('confirm-overlay');
    fireEvent.click(screen.getByTestId('confirm-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('claim-burn-status')).toHaveTextContent('Transaction failed'),
    );
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '20' } });
    expect(screen.getByTestId('claim-burn-status')).not.toHaveTextContent('Transaction failed');
  });
});

describe('ClaimBurn — input validation', () => {
  it('shows error and disables submit when amount is empty', () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    expect(screen.getByTestId('submit-btn')).toBeDisabled();
    expect(screen.queryByTestId('amount-error')).not.toBeInTheDocument();
  });

  it('shows error and disables submit when amount is zero', () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '0' } });
    expect(screen.getByTestId('submit-btn')).toBeDisabled();
    expect(screen.getByTestId('amount-error')).toBeInTheDocument();
  });

  it('shows error and disables submit when amount is negative', () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '-5' } });
    expect(screen.getByTestId('submit-btn')).toBeDisabled();
    expect(screen.getByTestId('amount-error')).toBeInTheDocument();
  });

  it('shows error and disables submit when amount is non-numeric', () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: 'abc' } });
    expect(screen.getByTestId('submit-btn')).toBeDisabled();
    expect(screen.getByTestId('amount-error')).toBeInTheDocument();
  });
});

describe('ClaimBurn — max balance button', () => {
  it('renders max button when balance is provided', () => {
    renderWithProviders(<ClaimBurn walletState="connected" balance="100.5" />);
    expect(screen.getByTestId('max-btn')).toBeInTheDocument();
  });

  it('does not render max button when balance is null', () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    expect(screen.queryByTestId('max-btn')).not.toBeInTheDocument();
  });

  it('sets amount input to balance when max button is clicked', () => {
    renderWithProviders(<ClaimBurn walletState="connected" balance="50" />);
    fireEvent.click(screen.getByTestId('max-btn'));
    expect(screen.getByTestId('amount-input')).toHaveValue('50');
  });

  it('disables max button while pending', async () => {
    const onClaim = vi.fn().mockResolvedValue({ hash: 'confirmed-hash', confirmed: true });
    renderWithProviders(<ClaimBurn walletState="connected" balance="10" onClaim={onClaim} />);
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('submit-btn'));
    await screen.findByTestId('confirm-overlay');
    fireEvent.click(screen.getByTestId('confirm-btn'));
    expect(screen.getByTestId('max-btn')).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByTestId('claim-burn-status')).toHaveTextContent('claimed successfully'),
    );
  });

  it('does not call onClaim when form is submitted while disconnected', () => {
    const onClaim = vi.fn();
    renderWithProviders(<ClaimBurn walletState="disconnected" onClaim={onClaim} />);
    fireEvent.submit(screen.getByTestId('claim-burn-form'));
    expect(onClaim).not.toHaveBeenCalled();
  });
});

describe('ClaimBurn — accessibility', () => {
  it('has aria-label on switch-network button', () => {
    renderWithProviders(<ClaimBurn walletState="wrongNetwork" expectedNetwork="testnet" />);
    expect(screen.getByTestId('switch-network-btn')).toHaveAttribute('aria-label');
  });

  it('has aria-label on retry-connect button', () => {
    renderWithProviders(<ClaimBurn walletState="error" />);
    expect(screen.getByTestId('retry-connect-btn')).toHaveAttribute('aria-label');
  });

  it('input has aria-describedby when error is shown', async () => {
    const onClaim = vi.fn().mockRejectedValue(new Error('Transaction failed'));
    renderWithProviders(<ClaimBurn walletState="connected" onClaim={onClaim} />);
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('submit-btn'));
    await screen.findByTestId('confirm-overlay');
    fireEvent.click(screen.getByTestId('confirm-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('claim-burn-status')).toHaveTextContent('Transaction failed'),
    );
    expect(screen.getByTestId('amount-input')).toHaveAttribute(
      'aria-describedby',
      'claim-burn-error',
    );
  });

  it('confirm overlay has dialog role and aria-modal', async () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    fireEvent.change(screen.getByTestId('amount-input'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('submit-btn'));
    const overlay = await screen.findByTestId('confirm-overlay');
    expect(overlay).toHaveAttribute('role', 'dialog');
    expect(overlay).toHaveAttribute('aria-modal', 'true');
  });

  it('toggle buttons reflect state with aria-pressed', () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    expect(screen.getByTestId('toggle-claim')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('toggle-burn')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('toggle-burn'));
    expect(screen.getByTestId('toggle-burn')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('toggle-claim')).toHaveAttribute('aria-pressed', 'false');
  });

  it('focus ring classes are present on submit button', () => {
    renderWithProviders(<ClaimBurn walletState="connected" />);
    const submitBtn = screen.getByTestId('submit-btn');
    expect(submitBtn.className).toContain('focus-visible:ring-2');
    expect(submitBtn.className).toContain('focus-visible:ring-emerald-500');
    expect(submitBtn.className).toContain('focus-visible:ring-offset-2');
  });
});
