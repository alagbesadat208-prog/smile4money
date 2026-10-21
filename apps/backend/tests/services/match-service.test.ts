/**
 * Unit tests for match-service.ts
 *
 * These tests exercise the service functions in isolation — no HTTP server,
 * no real chess-platform API calls. External dependencies are vi.mock'd.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateCreateMatchInput,
  validateGameExists,
  getGameResultWithPlayerIdentities,
  createMatchForPlayer,
} from '../../src/services/match-service.js';
import { MatchStore } from '../../src/store/match-store.js';

// ---------------------------------------------------------------------------
// Mock external fetchers
// ---------------------------------------------------------------------------
vi.mock('../../src/fetchers/lichess.js', () => ({
  fetchLichessResult: vi.fn(),
  GameNotFoundError: class GameNotFoundError extends Error {
    constructor(gameId: string) {
      super(`Lichess game not found: ${gameId}`);
      this.name = 'GameNotFoundError';
    }
  },
}));

vi.mock('../../src/fetchers/chessdotcom.js', () => ({
  fetchChessDotComResult: vi.fn(),
}));

import { fetchLichessResult } from '../../src/fetchers/lichess.js';
import { fetchChessDotComResult } from '../../src/fetchers/chessdotcom.js';
import { GameNotFoundError } from '../../src/fetchers/lichess.js';

const mockFetchLichess = vi.mocked(fetchLichessResult);
const mockFetchChess = vi.mocked(fetchChessDotComResult);

const LICHESS_GAME = {
  gameId: 'game-abc',
  status: 'mate',
  whitePlayer: 'alice',
  blackPlayer: 'bob',
  result: 'Player1Wins' as const,
};

const CHESS_GAME = {
  gameId: 'game-xyz',
  status: 'finished',
  whitePlayer: 'alice',
  blackPlayer: 'bob',
  result: 'Player1Wins' as const,
};

// ---------------------------------------------------------------------------
// validateCreateMatchInput
// ---------------------------------------------------------------------------
describe('validateCreateMatchInput', () => {
  const PLAYER1 = 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const PLAYER2 = 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  it('returns null when all fields are valid', () => {
    const result = validateCreateMatchInput(PLAYER1, {
      player2: PLAYER2,
      stakeAmount: 100,
      token: 'XLM',
      gameId: 'game-abc',
      platform: 'lichess',
    });
    expect(result).toBeNull();
  });

  it('returns error when player2 is missing', () => {
    expect(validateCreateMatchInput(PLAYER1, { stakeAmount: 100, token: 'XLM', gameId: 'g', platform: 'lichess' }))
      .toBe('player2 is required');
  });

  it('returns error when stakeAmount is not a number', () => {
    expect(validateCreateMatchInput(PLAYER1, {
      player2: PLAYER2, stakeAmount: 'bad' as any, token: 'XLM', gameId: 'g', platform: 'lichess',
    })).toBe('stakeAmount must be a whole number of token base units');
  });

  it('returns error when stakeAmount is a float', () => {
    expect(validateCreateMatchInput(PLAYER1, {
      player2: PLAYER2, stakeAmount: 1.5, token: 'XLM', gameId: 'g', platform: 'lichess',
    })).toBe('stakeAmount must be a whole number of token base units');
  });

  it('returns error when stakeAmount is zero', () => {
    expect(validateCreateMatchInput(PLAYER1, {
      player2: PLAYER2, stakeAmount: 0, token: 'XLM', gameId: 'g', platform: 'lichess',
    })).toContain('between 1 and 10000000000000');
  });

  it('returns error when stakeAmount is negative', () => {
    expect(validateCreateMatchInput(PLAYER1, {
      player2: PLAYER2, stakeAmount: -5, token: 'XLM', gameId: 'g', platform: 'lichess',
    })).toContain('between 1 and 10000000000000');
  });

  it('returns error when token is missing', () => {
    expect(validateCreateMatchInput(PLAYER1, {
      player2: PLAYER2, stakeAmount: 100, token: '' as any, gameId: 'g', platform: 'lichess',
    })).toBe('token is required');
  });

  it('returns error when gameId is missing', () => {
    expect(validateCreateMatchInput(PLAYER1, {
      player2: PLAYER2, stakeAmount: 100, token: 'XLM', gameId: '', platform: 'lichess',
    })).toBe('gameId is required');
  });

  it('rejects game IDs beyond the contract byte limit', () => {
    expect(validateCreateMatchInput(PLAYER1, {
      player2: PLAYER2, stakeAmount: 100, token: 'XLM', gameId: 'a'.repeat(512), platform: 'lichess',
    })).toContain('1-64 ASCII characters');
  });

  it('matches contract game ID boundary and character rules', () => {
    const input = { player2: PLAYER2, stakeAmount: 100, token: 'XLM', gameId: 'a'.repeat(64), platform: 'lichess' };
    expect(validateCreateMatchInput(PLAYER1, input)).toBeNull();
    expect(validateCreateMatchInput(PLAYER1, { ...input, gameId: 'a'.repeat(65) })).toContain('1-64 ASCII');
    expect(validateCreateMatchInput(PLAYER1, { ...input, gameId: 'a.b' })).toContain('1-64 ASCII');
    expect(validateCreateMatchInput(PLAYER1, { ...input, gameId: 'é' })).toContain('1-64 ASCII');
  });

  it('matches contract stake bounds in integer token units', () => {
    const input = { player2: PLAYER2, stakeAmount: 10_000_000_000_000, token: 'XLM', gameId: 'g', platform: 'lichess' };
    expect(validateCreateMatchInput(PLAYER1, input)).toBeNull();
    expect(validateCreateMatchInput(PLAYER1, { ...input, stakeAmount: 10_000_000_000_001 })).toContain('between 1 and 10000000000000');
  });

  it('returns error when platform is invalid', () => {
    expect(validateCreateMatchInput(PLAYER1, {
      player2: PLAYER2, stakeAmount: 100, token: 'XLM', gameId: 'g', platform: 'unknown',
    })).toBe('platform must be lichess or chessdotcom');
  });

  it('returns error when player1 and player2 are the same address (case-insensitive)', () => {
    expect(validateCreateMatchInput(PLAYER1.toLowerCase(), {
      player2: PLAYER1.toUpperCase(), stakeAmount: 100, token: 'XLM', gameId: 'g', platform: 'lichess',
    })).toBe('player1 and player2 must be different addresses');
  });

  it('accepts chessdotcom as a valid platform', () => {
    expect(validateCreateMatchInput(PLAYER1, {
      player2: PLAYER2, stakeAmount: 100, token: 'XLM', gameId: 'g', platform: 'chessdotcom',
    })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateGameExists
// ---------------------------------------------------------------------------
describe('validateGameExists', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns { valid: true } when lichess game is found', async () => {
    mockFetchLichess.mockResolvedValue(LICHESS_GAME);
    const result = await validateGameExists('lichess', 'game-abc');
    expect(result).toEqual({ valid: true });
  });

  it('returns { valid: false, error } when lichess game is not found', async () => {
    mockFetchLichess.mockRejectedValue(new GameNotFoundError('game-abc'));
    const result = await validateGameExists('lichess', 'game-abc');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('game-abc');
  });

  it('returns { valid: false, error } on unexpected lichess error', async () => {
    mockFetchLichess.mockRejectedValue(new Error('Network failure'));
    const result = await validateGameExists('lichess', 'game-abc');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Game validation failed');
  });

  it('returns { valid: true } when chessdotcom game is found', async () => {
    mockFetchChess.mockResolvedValue(CHESS_GAME);
    const result = await validateGameExists('chessdotcom', 'game-xyz', 'alice');
    expect(result).toEqual({ valid: true });
  });

  it('returns { valid: false } when chessdotcom is called without username', async () => {
    const result = await validateGameExists('chessdotcom', 'game-xyz');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('username is required');
  });

  it('returns { valid: false } for unknown platform', async () => {
    const result = await validateGameExists('unknown', 'game-abc');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid platform');
  });
});

// ---------------------------------------------------------------------------
// getGameResultWithPlayerIdentities
// ---------------------------------------------------------------------------
describe('getGameResultWithPlayerIdentities', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns player names from lichess result', async () => {
    mockFetchLichess.mockResolvedValue(LICHESS_GAME);
    const result = await getGameResultWithPlayerIdentities('lichess', 'game-abc');
    expect(result).toEqual({ whitePlayer: 'alice', blackPlayer: 'bob' });
  });

  it('returns error when lichess fetch fails', async () => {
    mockFetchLichess.mockRejectedValue(new Error('API down'));
    const result = await getGameResultWithPlayerIdentities('lichess', 'game-abc');
    expect(result.error).toBe('API down');
  });

  it('returns player names from chessdotcom result', async () => {
    mockFetchChess.mockResolvedValue(CHESS_GAME);
    const result = await getGameResultWithPlayerIdentities('chessdotcom', 'game-xyz', 'alice');
    expect(result).toEqual({ whitePlayer: 'alice', blackPlayer: 'bob' });
  });

  it('returns error when chessdotcom is called without username', async () => {
    const result = await getGameResultWithPlayerIdentities('chessdotcom', 'game-xyz');
    expect(result.error).toContain('username is required');
  });

  it('returns error for unknown platform', async () => {
    const result = await getGameResultWithPlayerIdentities('unknown', 'game-abc');
    expect(result.error).toBe('invalid platform');
  });
});

// ---------------------------------------------------------------------------
// createMatchForPlayer
// ---------------------------------------------------------------------------
describe('createMatchForPlayer', () => {
  const PLAYER1 = 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const PLAYER2 = 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  let store: MatchStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MatchStore();
  });

  it('creates a match and returns ok:true when game is found on lichess', async () => {
    mockFetchLichess.mockResolvedValue(LICHESS_GAME);

    const result = await createMatchForPlayer(store, PLAYER1, {
      player2: PLAYER2,
      stakeAmount: 100,
      token: 'XLM',
      gameId: 'game-abc',
      platform: 'lichess',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.match.player1).toBe(PLAYER1);
      expect(result.match.player2).toBe(PLAYER2);
      expect(result.match.gameId).toBe('game-abc');
      expect(result.match.state).toBe('Pending');
      expect(result.match.player1Username).toBe('alice');
      expect(result.match.player2Username).toBe('bob');
      // #1720 — the identity hash binding the match's players is computed
      // and stored at creation time, before any result has been submitted.
      expect(result.match.identityHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns ok:false with 400 when input validation fails', async () => {
    const result = await createMatchForPlayer(store, PLAYER1, {
      player2: PLAYER2,
      stakeAmount: -1,
      token: 'XLM',
      gameId: 'game-abc',
      platform: 'lichess',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it('returns ok:false with 400 when game is not found', async () => {
    mockFetchLichess.mockRejectedValue(new GameNotFoundError('game-abc'));

    const result = await createMatchForPlayer(store, PLAYER1, {
      player2: PLAYER2,
      stakeAmount: 100,
      token: 'XLM',
      gameId: 'game-abc',
      platform: 'lichess',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe('Invalid game');
    }
  });

  it('returns ok:false with 409 for duplicate gameId', async () => {
    mockFetchLichess.mockResolvedValue(LICHESS_GAME);

    // Create the match once
    await createMatchForPlayer(store, PLAYER1, {
      player2: PLAYER2,
      stakeAmount: 100,
      token: 'XLM',
      gameId: 'game-abc',
      platform: 'lichess',
    });

    // Try again with the same gameId
    mockFetchLichess.mockResolvedValue({ ...LICHESS_GAME });
    const result = await createMatchForPlayer(store, PLAYER1, {
      player2: PLAYER2,
      stakeAmount: 100,
      token: 'XLM',
      gameId: 'game-abc',
      platform: 'lichess',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe('duplicate gameId');
    }
  });
});
