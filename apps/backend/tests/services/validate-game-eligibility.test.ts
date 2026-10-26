/**
 * validateGame applies the eligibility rules (#110): an existing game that
 * breaks a rule is rejected with HTTP 422 and machine-readable reasons.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateGame } from '../../src/services/validate-game-service.js';
import { statusToErrorCode } from '../../src/errors/errorResponse.js';

vi.mock('../../src/fetchers/lichess.js', () => ({
  fetchLichessResult: vi.fn(),
  GameNotFoundError: class GameNotFoundError extends Error {},
}));
vi.mock('../../src/fetchers/chessdotcom.js', () => ({
  fetchChessDotComResult: vi.fn(),
}));

import { fetchLichessResult } from '../../src/fetchers/lichess.js';
import { fetchChessDotComResult } from '../../src/fetchers/chessdotcom.js';

const mockLichess = vi.mocked(fetchLichessResult);
const mockChess = vi.mocked(fetchChessDotComResult);

const GAME = {
  gameId: 'abc123',
  status: 'mate',
  whitePlayer: 'alice',
  blackPlayer: 'bob',
  result: 'Player1Wins' as const,
};

beforeEach(() => vi.clearAllMocks());

describe('validateGame eligibility (#110)', () => {
  it('accepts an eligible game unchanged', async () => {
    mockLichess.mockResolvedValue(GAME);
    const result = await validateGame({ gameId: 'abc123', platform: 'lichess' });
    expect(result).toMatchObject({ ok: true, valid: true, status: 'mate', result: 'Player1Wins' });
  });

  it('rejects a game that never started, even though the fetcher reports a result', async () => {
    mockLichess.mockResolvedValue({ ...GAME, status: 'noStart', result: 'Draw' });
    const result = await validateGame({ gameId: 'abc123', platform: 'lichess' });
    expect(result).toEqual({
      ok: false,
      status: 422,
      valid: false,
      platform: 'lichess',
      gameId: 'abc123',
      message: 'The game ended as "noStart", which has no verifiable result.',
      rejections: [
        {
          code: 'UNVERIFIABLE_COMPLETION',
          message: 'The game ended as "noStart", which has no verifiable result.',
        },
      ],
    });
  });

  it('applies variant and time-control rules when the fetcher supplies metadata', async () => {
    mockChess.mockResolvedValue({
      ...GAME,
      status: 'finished',
      metadata: { variant: 'chess960', speed: 'daily', initialSeconds: null },
    } as typeof GAME);
    const result = await validateGame({
      gameId: 'abc123',
      platform: 'chessdotcom',
      username: 'alice',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    expect('rejections' in result && result.rejections.map((r) => r.code)).toEqual([
      'UNSUPPORTED_VARIANT',
      'UNSUPPORTED_TIME_CONTROL',
      'NO_CLOCK',
    ]);
  });

  it('maps the rejection to a validation error code, not an internal error', () => {
    expect(statusToErrorCode(422)).toBe('VALIDATION_ERROR');
  });
});
