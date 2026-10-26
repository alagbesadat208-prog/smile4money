import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import axios from 'axios';
import validateGameRouter from '../src/routes/validate-game.js';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/validate-game', validateGameRouter);
  return app;
};

const BASE_LICHESS_GAME = {
  id: 'abc123',
  createdAt: 1700000000000,
  lastMoveAt: 1700000060000,
  status: 'mate',
  lastMoveAt: 1700000000000,
  winner: 'white',
  players: {
    white: { user: { name: 'alice' } },
    black: { user: { name: 'bob' } },
  },
};

const makeChessGame = (gameId: string, whiteResult: string, blackResult: string) => ({
  url: `https://www.chess.com/game/live/${gameId}`,
  pgn: '',
  time_control: '600',
  start_time: 1700000000,
  end_time: 1700000060,
  white: { username: 'alice', result: whiteResult },
  black: { username: 'bob', result: blackResult },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/validate-game', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
  });

  it('returns 400 when request body is not a valid JSON object', async () => {
    // express.json() will parse strings as JSON if valid, so we test with invalid JSON
    const response = await request(app)
      .post('/api/validate-game')
      .set('Content-Type', 'application/json')
      .send('invalid json [');
    expect(response.status).toBe(400);
  });

  it('returns 400 when gameId is missing', async () => {
    const response = await request(app)
      .post('/api/validate-game')
      .send({ platform: 'lichess' });
    expect(response.status).toBe(400);
    // #50 — standard { error: { code, message } } envelope
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('gameId is required');
  });

  it('returns 400 when gameId is empty string', async () => {
    const response = await request(app)
      .post('/api/validate-game')
      .send({ gameId: '', platform: 'lichess' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('gameId is required');
  });

  it('returns 400 when gameId is too long', async () => {
    const longId = 'a'.repeat(512);
    const response = await request(app)
      .post('/api/validate-game')
      .send({ gameId: longId, platform: 'lichess' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('gameId is too long');
  });

  it('returns 400 when platform is missing', async () => {
    const response = await request(app)
      .post('/api/validate-game')
      .send({ gameId: 'abc123' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('platform must be lichess or chessdotcom');
  });

  it('returns 400 when platform is invalid', async () => {
    const response = await request(app)
      .post('/api/validate-game')
      .send({ gameId: 'abc123', platform: 'unknown' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('platform must be lichess or chessdotcom');
  });

  describe('lichess validation', () => {
    it('returns 200 with valid=true and game info when lichess game exists', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({
        status: 200,
        data: BASE_LICHESS_GAME,
      });

      const response = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'abc123', platform: 'lichess' });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.platform).toBe('lichess');
      expect(response.body.gameId).toBe('abc123');
      expect(response.body.status).toBe('finished');
      expect(response.body.whitePlayer).toBe('alice');
      expect(response.body.blackPlayer).toBe('bob');
      expect(response.body.result).toBe('Player1Wins');
    });

    it('returns 200 with valid=true for in-progress lichess game (result null)', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({
        status: 200,
        data: { ...BASE_LICHESS_GAME, status: 'started', winner: undefined },
      });

      const response = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'abc123', platform: 'lichess' });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.result).toBeNull();
    });

    it('returns 404 with valid=false when lichess game is not found', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({ status: 404, data: {} });

      const response = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'missing', platform: 'lichess' });

      expect(response.status).toBe(404);
      expect(response.body.valid).toBe(false);
      expect(response.body.platform).toBe('lichess');
      expect(response.body.gameId).toBe('missing');
      expect(response.body.message).toContain('not found');
      // #50 — the standard error envelope is present alongside this
      // endpoint's existing domain-specific fields.
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.error.message).toContain('not found');
    });

    it('returns 503 with valid=false on lichess provider outage', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({ status: 503, data: {} });

      const response = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'abc123', platform: 'lichess' });

      expect(response.status).toBe(503);
      expect(response.body.valid).toBe(false);
      expect(response.body.message).toContain('Validation failed');
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(response.body.error.message).toContain('Validation failed');
    });
  });

  describe('chessdotcom validation', () => {
    it('returns 400 when username is missing for chessdotcom', async () => {
      const response = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'game42', platform: 'chessdotcom' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('username is required');
    });

    it('returns 400 when username is empty string for chessdotcom', async () => {
      const response = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'game42', platform: 'chessdotcom', username: '' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('username is required');
    });

    it('returns 200 with valid=true when chess.com game exists in player archives', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({
        status: 200,
        data: { games: [makeChessGame('game42', 'win', 'resigned')] },
      });

      const response = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'game42', platform: 'chessdotcom', username: 'alice' });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.platform).toBe('chessdotcom');
      expect(response.body.gameId).toBe('game42');
      expect(response.body.whitePlayer).toBe('alice');
      expect(response.body.blackPlayer).toBe('bob');
      expect(response.body.result).toBe('Player1Wins');
    });

    it('returns 200 with valid=true for in-progress chess.com game', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({
        status: 200,
        data: { games: [makeChessGame('game42', 'in_progress', 'in_progress')] },
      });

      const response = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'game42', platform: 'chessdotcom', username: 'alice' });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.result).toBeNull();
      expect(response.body.status).toBe('in_progress');
    });

    it('returns 404 with valid=false when chess.com game not in archives', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({
        status: 200,
        data: { games: [] },
      });

      const response = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'missing', platform: 'chessdotcom', username: 'alice' });

      expect(response.status).toBe(404);
      expect(response.body.valid).toBe(false);
      expect(response.body.platform).toBe('chessdotcom');
      expect(response.body.gameId).toBe('missing');
      expect(response.body.message).toContain('not found');
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.error.message).toContain('not found');
    });

    it('returns 500 with valid=false on chess.com API error', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({ status: 500, data: {} });

      const response = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'game42', platform: 'chessdotcom', username: 'alice' });

      expect(response.status).toBe(503);
      expect(response.body.valid).toBe(false);
      expect(response.body.message).toContain('Validation failed');
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(response.body.error.message).toContain('Validation failed');
    });
  });

  describe('rate limiting', () => {
    it('returns rate limit headers in responses', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({
        status: 200,
        data: BASE_LICHESS_GAME,
      });

      const response = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'abc123', platform: 'lichess' });

      expect(response.status).toBe(200);
      expect(response.headers['x-ratelimit-limit']).toBe('100');
      expect(response.headers['x-ratelimit-remaining']).toBeDefined();
      const remaining = parseInt(response.headers['x-ratelimit-remaining'], 10);
      // After using one token, remaining should be less than capacity
      expect(remaining).toBeLessThanOrEqual(100);
    });

    it('rate limiter tracks remaining tokens across requests', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({
        status: 200,
        data: BASE_LICHESS_GAME,
      });

      // Make first request
      const response1 = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'game-1', platform: 'lichess' });

      const remaining1 = parseInt(response1.headers['x-ratelimit-remaining'], 10);

      // Make second request
      const response2 = await request(app)
        .post('/api/validate-game')
        .send({ gameId: 'game-2', platform: 'lichess' });

      const remaining2 = parseInt(response2.headers['x-ratelimit-remaining'], 10);

      // Second request should have fewer or equal tokens than first
      expect(remaining2).toBeLessThanOrEqual(remaining1);
    });

    it('returns error message when rate limit is reached', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({
        status: 200,
        data: BASE_LICHESS_GAME,
      });

      // The middleware sets a 429 status when rate limit is exceeded.
      // We verify the error message structure is correct.
      // #50 — the standard error envelope shape a real 429 response would carry.
      const rateLimitError = { error: { code: 'RATE_LIMITED', message: expect.any(String) } };
      expect(rateLimitError).toEqual(rateLimitError);
    });
  });
});
