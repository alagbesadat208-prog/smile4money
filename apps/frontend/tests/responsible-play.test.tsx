/**
 * Responsible-play controls (#114): self-exclusion and stake limits, and
 * that an excluded account cannot start the create-match or deposit flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Keypair } from '@stellar/stellar-sdk';
import { CreateMatch } from '../src/components/CreateMatch';
import { ResponsiblePlay } from '../src/components/ResponsiblePlay';
import {
  LIMIT_INCREASE_DELAY_MS,
  SELF_EXCLUSION_PERIODS,
  activeExclusion,
  checkWagerAllowed,
  effectiveSettings,
  loadSettings,
  setStakeLimit,
  startSelfExclusion,
  storageKey,
} from '../src/utils/responsible-play';

const PLAYER = Keypair.random().publicKey();
const OPPONENT = Keypair.random().publicKey();
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('self-exclusion', () => {
  it('blocks wagering until it ends, then allows it again', () => {
    startSelfExclusion(PLAYER, '7d', NOW);
    const check = checkWagerAllowed(PLAYER, 1n, NOW + DAY);
    expect(check).toMatchObject({ allowed: false, reason: 'self_excluded', until: NOW + 7 * DAY });
    expect(checkWagerAllowed(PLAYER, 1n, NOW + 7 * DAY + 1)).toEqual({ allowed: true });
  });

  it('cannot be shortened, only extended', () => {
    startSelfExclusion(PLAYER, '30d', NOW);
    expect(startSelfExclusion(PLAYER, '24h', NOW + DAY).until).toBe(NOW + 30 * DAY);
    expect(startSelfExclusion(PLAYER, '6m', NOW + DAY).until).toBe(
      NOW + DAY + SELF_EXCLUSION_PERIODS['6m'],
    );
  });

  it('applies per address', () => {
    startSelfExclusion(PLAYER, '24h', NOW);
    expect(activeExclusion(OPPONENT, NOW)).toBeNull();
    expect(checkWagerAllowed(OPPONENT, 1n, NOW)).toEqual({ allowed: true });
  });

  it('ignores malformed stored data', () => {
    window.localStorage.setItem(
      storageKey(PLAYER),
      '{"excludedUntil":"forever","stakeLimit":"-1"}',
    );
    expect(loadSettings(PLAYER)).toEqual({});
    window.localStorage.setItem(storageKey(PLAYER), 'not json');
    expect(loadSettings(PLAYER)).toEqual({});
  });
});

describe('stake limit', () => {
  it('blocks a stake above the limit and allows one at it', () => {
    setStakeLimit(PLAYER, 50_000_000n, NOW);
    expect(checkWagerAllowed(PLAYER, 50_000_000n, NOW)).toEqual({ allowed: true });
    const check = checkWagerAllowed(PLAYER, 50_000_001n, NOW);
    expect(check).toMatchObject({ allowed: false, reason: 'stake_limit', limit: 50_000_000n });
    expect(!check.allowed && check.message).toContain('5 per match');
  });

  it('lowers immediately but raises only after the delay', () => {
    setStakeLimit(PLAYER, 50_000_000n, NOW);
    expect(setStakeLimit(PLAYER, 10_000_000n, NOW).effectiveAt).toBe(NOW);
    expect(effectiveSettings(PLAYER, NOW).stakeLimit).toBe('10000000');

    const raise = setStakeLimit(PLAYER, 100_000_000n, NOW);
    expect(raise.effectiveAt).toBe(NOW + LIMIT_INCREASE_DELAY_MS);
    expect(checkWagerAllowed(PLAYER, 20_000_000n, NOW + LIMIT_INCREASE_DELAY_MS - 1).allowed).toBe(
      false,
    );
    expect(checkWagerAllowed(PLAYER, 20_000_000n, NOW + LIMIT_INCREASE_DELAY_MS).allowed).toBe(
      true,
    );
  });

  it('removes a limit only after the delay', () => {
    setStakeLimit(PLAYER, 10_000_000n, NOW);
    setStakeLimit(PLAYER, null, NOW);
    expect(checkWagerAllowed(PLAYER, 20_000_000n, NOW).allowed).toBe(false);
    expect(checkWagerAllowed(PLAYER, 20_000_000n, NOW + LIMIT_INCREASE_DELAY_MS).allowed).toBe(
      true,
    );
  });

  it('reports when storage is unavailable instead of pretending to save', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(setStakeLimit(PLAYER, 1n, NOW).saved).toBe(false);
    expect(startSelfExclusion(PLAYER, '24h', NOW).saved).toBe(false);
  });
});

function fillCreateMatch() {
  fireEvent.change(screen.getByTestId('player2-input'), { target: { value: OPPONENT } });
  fireEvent.change(screen.getByTestId('stake-amount-input'), { target: { value: '5' } });
  fireEvent.change(screen.getByTestId('game-id-input'), { target: { value: 'abcd1234' } });
}

describe('enforcement in the wager flows', () => {
  it('an excluded account cannot start create-match: nothing is validated or signed', async () => {
    startSelfExclusion(PLAYER, '7d');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onCreateMatch = vi.fn();
    render(<CreateMatch contractId="c" player1Address={PLAYER} onCreateMatch={onCreateMatch} />);

    fillCreateMatch();
    fireEvent.click(screen.getByTestId('submit-match-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('create-match-error')).toHaveTextContent(/self-excluded/i),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onCreateMatch).not.toHaveBeenCalled();
  });

  it('a stake above the limit cannot start create-match', async () => {
    setStakeLimit(PLAYER, 10_000_000n);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<CreateMatch contractId="c" player1Address={PLAYER} />);

    fillCreateMatch();
    fireEvent.click(screen.getByTestId('submit-match-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('create-match-error')).toHaveTextContent(/above your limit/i),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the payout breakdown once a stake is entered', () => {
    render(<CreateMatch contractId="c" player1Address={PLAYER} />);
    expect(screen.queryByTestId('payout-breakdown')).toBeNull();
    fillCreateMatch();
    expect(screen.getByTestId('payout-win')).toHaveTextContent('+5 XLM');
  });
});

describe('<ResponsiblePlay>', () => {
  it('starts a self-exclusion only after confirmation', () => {
    render(<ResponsiblePlay address={PLAYER} />);
    fireEvent.click(screen.getByTestId('self-exclusion-7d'));
    expect(activeExclusion(PLAYER)).toBeNull();

    fireEvent.click(screen.getByTestId('self-exclusion-confirm'));
    expect(activeExclusion(PLAYER)).not.toBeNull();
    expect(screen.getByTestId('self-exclusion-active')).toBeInTheDocument();
  });

  it('sets a stake limit and explains that raising it is delayed', () => {
    render(<ResponsiblePlay address={PLAYER} />);
    fireEvent.change(screen.getByTestId('stake-limit-input'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('stake-limit-save'));
    expect(screen.getByTestId('stake-limit-current')).toHaveTextContent('Current limit: 5.');

    fireEvent.change(screen.getByTestId('stake-limit-input'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('stake-limit-save'));
    expect(screen.getByTestId('responsible-play-message')).toHaveTextContent(/waits 24 hours/);
    expect(screen.getByTestId('stake-limit-current')).toHaveTextContent('Current limit: 5.');
  });

  it('renders nothing without a connected address', () => {
    const { container } = render(<ResponsiblePlay address={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
