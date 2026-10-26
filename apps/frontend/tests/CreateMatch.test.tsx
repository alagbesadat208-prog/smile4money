import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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

  it('offers only assets configured for the selected network', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    expect(screen.getByTestId('toggle-xlm')).toBeInTheDocument();
    expect(screen.queryByTestId('toggle-usdc')).not.toBeInTheDocument();
  });

  it('renders platform selector with Lichess and Chess.com options', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    expect(screen.getByTestId('platform-lichess')).toBeInTheDocument();
    expect(screen.getByTestId('platform-chesscom')).toBeInTheDocument();
  });

  it('defaults to XLM token', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    expect(screen.getByTestId('toggle-xlm')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('toggle-usdc')).not.toBeInTheDocument();
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

describe('CreateMatch — token configuration', () => {
  it('does not offer USDC when its network deployment is not configured', () => {
    render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
    expect(screen.queryByTestId('toggle-usdc')).not.toBeInTheDocument();
  });

  it('disables match creation when the selected network has no configured assets', () => {
    render(
      <CreateMatch
        contractId="test-contract"
        player1Address={validAddress}
        networkPassphrase="unsupported-network"
      />,
    );
    expect(screen.queryByTestId('toggle-xlm')).not.toBeInTheDocument();
    expect(screen.getByTestId('submit-match-btn')).toBeDisabled();
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
