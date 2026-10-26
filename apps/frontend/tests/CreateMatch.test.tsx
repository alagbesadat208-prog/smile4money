import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { CreateMatch } from '../src/components/CreateMatch';

const validAddress = 'GAUXUJLYWYXK7UE22KXN5WJTP2MNOWVL4ZRDBJQ43WZB5HJP22JSYTRR';
describe('CreateMatch — rendering', () => {
  it('renders the form with all required fields', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    expect(screen.getByTestId('create-match')).toBeInTheDocument();
    expect(screen.getByTestId('player2-input')).toBeInTheDocument();
    expect(screen.getByTestId('stake-amount-input')).toBeInTheDocument();
    expect(screen.getByTestId('game-id-input')).toBeInTheDocument();
  });

  it('renders token toggle with XLM and USDC options', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    expect(screen.getByTestId('toggle-xlm')).toBeInTheDocument();
    expect(screen.getByTestId('toggle-usdc')).toBeInTheDocument();
  });

  it('renders platform selector with Lichess and Chess.com options', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    expect(screen.getByTestId('platform-lichess')).toBeInTheDocument();
    expect(screen.getByTestId('platform-chesscom')).toBeInTheDocument();
  });

  it('defaults to XLM token', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    expect(screen.getByTestId('toggle-xlm')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('toggle-usdc')).toHaveAttribute('aria-pressed', 'false');
  });

  it('defaults to Lichess platform', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    expect(screen.getByTestId('platform-lichess')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('platform-chesscom')).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows Create Match button', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    expect(screen.getByTestId('submit-match-btn')).toBeInTheDocument();
  });
});

describe('CreateMatch — token toggle', () => {
  it('toggles between XLM and USDC', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    fireEvent.click(screen.getByTestId('toggle-usdc'));
    expect(screen.getByTestId('toggle-usdc')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('toggle-xlm')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('CreateMatch — platform toggle', () => {
  it('toggles between Lichess and Chess.com', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    fireEvent.click(screen.getByTestId('platform-chesscom'));
    expect(screen.getByTestId('platform-chesscom')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('platform-lichess')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('CreateMatch — form interaction', () => {
  it('allows user to type in player2 address field', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);

    const input = screen.getByTestId('player2-input');
    fireEvent.change(input, {
      target: { value: 'GTESTADDRESS123456789012345678901234567890TEST' },
    });

    expect(input).toHaveValue('GTESTADDRESS123456789012345678901234567890TEST');
  });

  it('allows user to type in stake amount field', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);

    const input = screen.getByTestId('stake-amount-input');
    fireEvent.change(input, { target: { value: '100' } });

    // The value should be '100' as a string
    expect((input as HTMLInputElement).value).toBe('100');
  });

  it('allows user to type in game ID field', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);

    const input = screen.getByTestId('game-id-input');
    fireEvent.change(input, { target: { value: 'game-abc123' } });

    expect(input).toHaveValue('game-abc123');
  });
});

describe('CreateMatch — game_id validation', () => {
  it('shows error when game ID is empty and form is submitted', async () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);

    fireEvent.click(screen.getByTestId('submit-match-btn'));

    expect(await screen.findByTestId('game-id-error')).toHaveTextContent('Game ID is required');
  });

  it('shows error when game ID exceeds 64 characters', async () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);

    const input = screen.getByTestId('game-id-input');
    // 65-character string
    fireEvent.change(input, { target: { value: 'a'.repeat(65) } });
    fireEvent.click(screen.getByTestId('submit-match-btn'));

    expect(await screen.findByTestId('game-id-error')).toHaveTextContent(
      'Game ID must be 64 characters or fewer',
    );
  });

  it('shows no error when game ID is exactly 64 characters', async () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);

    const input = screen.getByTestId('game-id-input');
    fireEvent.change(input, { target: { value: 'a'.repeat(64) } });
    fireEvent.click(screen.getByTestId('submit-match-btn'));

    expect(screen.queryByTestId('game-id-error')).not.toBeInTheDocument();
  });

  it('shows error when game ID is a duplicate of a known game ID', async () => {
    const knownGameIds = ['existing-game-123'];
    render(
      <CreateMatch
        contractId="test-contract"
        player1Address={validAddress}
        knownGameIds={knownGameIds}
      />,
    );

    const input = screen.getByTestId('game-id-input');
    fireEvent.change(input, { target: { value: 'existing-game-123' } });
    fireEvent.click(screen.getByTestId('submit-match-btn'));

    expect(await screen.findByTestId('game-id-error')).toHaveTextContent(
      'A match with this game ID already exists',
    );
  });

  it('shows no error when game ID is unique', async () => {
    const knownGameIds = ['existing-game-123'];
    render(
      <CreateMatch
        contractId="test-contract"
        player1Address={validAddress}
        knownGameIds={knownGameIds}
      />,
    );

    const input = screen.getByTestId('game-id-input');
    fireEvent.change(input, { target: { value: 'new-unique-game-456' } });
    fireEvent.click(screen.getByTestId('submit-match-btn'));

    expect(screen.queryByTestId('game-id-error')).not.toBeInTheDocument();
  });
});

describe('CreateMatch — transaction review before signature', () => {
  const validAddress = 'GA3LQZYOJCAZSMLI47BXMCV2C4SJPZWPLJO7AR76GO56N2QB2DCKTVMV';

  let fetchMock: MockInstance<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new globalThis.Response(JSON.stringify({ valid: true }), { status: 200 }),
    );
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  function fillValidForm() {
    fireEvent.change(screen.getByTestId('player2-input'), {
      target: { value: validAddress },
    });
    fireEvent.change(screen.getByTestId('stake-amount-input'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('game-id-input'), { target: { value: 'game-abc123' } });
  }

  it('shows a review step derived from the submitted inputs after validation passes', async () => {
    const onCreateMatch = vi.fn().mockResolvedValue('match-123');
    render(
      <CreateMatch contractId="test-contract" player1Address={validAddress} onCreateMatch={onCreateMatch} />,
    );

    fillValidForm();
    fireEvent.click(screen.getByTestId('submit-match-btn'));

    const review = await screen.findByTestId('transaction-review');
    expect(review).toBeInTheDocument();
    // Opponent (player 2), asset, stake, network, contract action.
    expect(screen.getByTestId('transaction-review-summary')).toHaveTextContent(validAddress);
    expect(screen.getByTestId('transaction-review-summary')).toHaveTextContent('XLM (native)');
    expect(screen.getByTestId('transaction-review-summary')).toHaveTextContent('10');
    expect(screen.getByTestId('transaction-review-summary')).toHaveTextContent('Testnet');
    expect(screen.getByTestId('transaction-review-summary')).toHaveTextContent('Create match');
    // The form is hidden while the review is shown.
    expect(screen.queryByTestId('create-match-form')).not.toBeInTheDocument();
  });

  it('confirms the review and submits the typed transaction payload', async () => {
    const onCreateMatch = vi.fn().mockResolvedValue('match-123');
    render(
      <CreateMatch contractId="test-contract" player1Address={validAddress} onCreateMatch={onCreateMatch} />,
    );

    fillValidForm();
    fireEvent.click(screen.getByTestId('submit-match-btn'));
    await screen.findByTestId('transaction-review');
    fireEvent.click(screen.getByTestId('review-confirm-btn'));

    await waitFor(() => expect(onCreateMatch).toHaveBeenCalledTimes(1));
    expect(onCreateMatch).toHaveBeenCalledWith({
      player2: validAddress,
      stakeAmount: '100000000', // 10 XLM converted to stroops
      token: 'xlm',
      gameId: 'game-abc123',
      platform: 'lichess',
      platformUsername: undefined,
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    expect(screen.getByTestId('match-success')).toBeInTheDocument();
  });

  it('cancelling the review returns to the form without submitting', async () => {
    const onCreateMatch = vi.fn().mockResolvedValue('match-123');
    render(
      <CreateMatch contractId="test-contract" player1Address={validAddress} onCreateMatch={onCreateMatch} />,
    );

    fillValidForm();
    fireEvent.click(screen.getByTestId('submit-match-btn'));
    await screen.findByTestId('transaction-review');
    fireEvent.click(screen.getByTestId('review-cancel-btn'));

    expect(onCreateMatch).not.toHaveBeenCalled();
    expect(screen.getByTestId('create-match-form')).toBeInTheDocument();
    expect(screen.queryByTestId('transaction-review')).not.toBeInTheDocument();
  });

  it('review shows an error and stays open when the submission fails', async () => {
    const onCreateMatch = vi.fn().mockRejectedValue(new Error('Insufficient balance'));
    render(
      <CreateMatch contractId="test-contract" player1Address={validAddress} onCreateMatch={onCreateMatch} />,
    );

    fillValidForm();
    fireEvent.click(screen.getByTestId('submit-match-btn'));
    await screen.findByTestId('transaction-review');
    fireEvent.click(screen.getByTestId('review-confirm-btn'));

    expect(await screen.findByTestId('transaction-review-error')).toHaveTextContent(
      'Insufficient balance',
    );
    expect(screen.getByTestId('transaction-review')).toBeInTheDocument();
  });
});