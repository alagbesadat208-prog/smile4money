import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import matchRouter from '../src/routes/matches.js';
import jwt from 'jsonwebtoken';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

const secret = 'test-secret';
const makeToken = (address = 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') =>
  jwt.sign({ address }, secret, { expiresIn: '1h' });

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/matches', matchRouter);
  return app;
};

const BASE_LICHESS_GAME = {
  id: 'lichess-game-abc123',
  status: 'mate',
  lastMoveAt: 1700000000000,
  winner: 'white',
  players: {
    white: { user: { name: 'alice' } },
    black: { user: { name: 'bob' } },
  },
};

function mockLichessGameFound(gameId: string) {
  mockedAxios.get = vi.fn().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('lichess.org') && url.includes(gameId)) {
      return { status: 200, data: { ...BASE_LICHESS_GAME, id: gameId } };
    }
    return { status: 404, data: {} };
  });
}

function mockChessGameFound(username: string, gameId: string) {
  mockedAxios.get = vi.fn().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('chess.com') && url.includes(username)) {
      return {
        status: 200,
        data: {
          games: [
            {
              url: `https://www.chess.com/game/live/${gameId}`,
              pgn: '',
              time_control: '600',
              end_time: 0,
              white: { username, result: 'win' },
              black: { username: 'bob', result: 'resigned' },
            },
          ],
        },
      };
    }
    return { status: 404, data: {} };
  });
}

describe('POST /api/matches', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const response = await request(app).post('/api/matches').send({});
    expect(response.status).toBe(401);
  });

  it('returns 401 when the JWT is malformed', async () => {
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', 'Bearer invalid.token')
      .send({});
    expect(response.status).toBe(401);
  });

  it('returns 400 when player2 is missing', async () => {
    mockLichessGameFound('lichess-game-abc123');
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ stakeAmount: 100, token: 'XLM', gameId: 'lichess-game-abc123', platform: 'lichess' });
    expect(response.status).toBe(400);
  });

  it('returns 400 when player2 matches the JWT address regardless of case', async () => {
    const player1Address = 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${makeToken(player1Address.toLowerCase())}`)
      .send({
        player2: player1Address,
        stakeAmount: 100,
        token: 'XLM',
        gameId: 'lichess-game-abc123',
        platform: 'lichess',
      });

    expect(response.status).toBe(400);
    // #50 — standard { error: { code, message } } envelope
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('player1 and player2 must be different addresses');
  });

  it('returns 400 when stakeAmount is missing', async () => {
    mockLichessGameFound('lichess-game-abc123');
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', token: 'XLM', gameId: 'lichess-game-abc123', platform: 'lichess' });
    expect(response.status).toBe(400);
  });

  it('returns 400 when stakeAmount is zero', async () => {
    mockLichessGameFound('lichess-game-abc123');
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', stakeAmount: 0, token: 'XLM', gameId: 'lichess-game-abc123', platform: 'lichess' });
    expect(response.status).toBe(400);
  });

  it('returns 400 when stakeAmount is not a whole number', async () => {
    mockLichessGameFound('lichess-game-abc123');
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', stakeAmount: 1.5, token: 'XLM', gameId: 'lichess-game-abc123', platform: 'lichess' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('stakeAmount must be a whole number of stroops');
  });

  it('returns 400 when gameId is missing', async () => {
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', stakeAmount: 100, token: 'XLM', platform: 'lichess' });
    expect(response.status).toBe(400);
  });

  it('returns 400 when platform is invalid', async () => {
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', stakeAmount: 100, token: 'XLM', gameId: 'lichess-game-abc123', platform: 'unknown' });
    expect(response.status).toBe(400);
  });

  it('returns 201 and matches created payload shape', async () => {
    mockLichessGameFound('lichess-game-abc123');
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', stakeAmount: 100, token: 'XLM', gameId: 'lichess-game-abc123', platform: 'lichess' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      matchId: expect.any(Number),
      stakeAmount: 100,
      token: 'XLM',
      gameId: 'lichess-game-abc123',
      platform: 'lichess',
      state: 'Pending',
    });
  });

  it('returns 409 for duplicate gameId', async () => {
    mockLichessGameFound('lichess-game-abc123');
    const token = makeToken();
    await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${token}`)
      .send({ player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', stakeAmount: 100, token: 'XLM', gameId: 'lichess-game-abc123', platform: 'lichess' });

    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${token}`)
      .send({ player2: 'GPLAYER3CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', stakeAmount: 100, token: 'XLM', gameId: 'lichess-game-abc123', platform: 'lichess' });

    expect(response.status).toBe(409);
    // #50 — standard { error: { code, message } } envelope
    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('returns 400 with Invalid game when lichess game does not exist', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({ status: 404, data: {} });
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', stakeAmount: 100, token: 'XLM', gameId: 'nonexistent-game', platform: 'lichess' });

    expect(response.status).toBe(400);
    // #50 — the previous separate `details` field is now folded into
    // error.message; the standard envelope has no top-level `details`.
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('Invalid game');
  });

  it('returns 400 with Invalid game when chessdotcom is missing username', async () => {
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', stakeAmount: 100, token: 'XLM', gameId: 'chess-game-1', platform: 'chessdotcom' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('Invalid game');
    expect(response.body.error.message).toContain('username is required');
  });

  it('returns 201 for chessdotcom when username provided and game exists', async () => {
    mockChessGameFound('alice', 'chess-game-1');
    const response = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        stakeAmount: 100,
        token: 'XLM',
        gameId: 'chess-game-1',
        platform: 'chessdotcom',
        username: 'alice',
      });

    expect(response.status).toBe(201);
    expect(response.body.gameId).toBe('chess-game-1');
    expect(response.body.platform).toBe('chessdotcom');
  });

  describe('JWT Authentication', () => {
    it('returns 401 with error and message when no Authorization header', async () => {
      const response = await request(app)
        .post('/api/matches')
        .send({});

      expect(response.status).toBe(401);
      // #50 — standard { error: { code, message } } envelope
      expect(response.body.error.code).toBe('UNAUTHORIZED');
      expect(response.body.error.message).toBeDefined();
    });

    it('returns 401 with error and message when Authorization header is malformed', async () => {
      const response = await request(app)
        .post('/api/matches')
        .set('Authorization', 'Bearer invalid.token.structure')
        .send({});

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
      expect(response.body.error.message).toBeDefined();
    });

    it('returns 401 with error and message when JWT has expired', async () => {
      const expiredToken = jwt.sign(
        { address: 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        secret,
        { expiresIn: '-1h' }, // Expired 1 hour ago
      );

      const response = await request(app)
        .post('/api/matches')
        .set('Authorization', `Bearer ${expiredToken}`)
        .send({});

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
      expect(response.body.error.message).toContain('expired');
    });

    it('returns 401 with error and message when JWT token lacks address claim', async () => {
      const badToken = jwt.sign({ user_id: '12345' }, secret, { expiresIn: '1h' });

      const response = await request(app)
        .post('/api/matches')
        .set('Authorization', `Bearer ${badToken}`)
        .send({});

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
      expect(response.body.error.message).toContain('Invalid');
    });

    it('successfully authenticates with valid JWT token', async () => {
      mockLichessGameFound('lichess-game-abc123');
      const validToken = makeToken();

      const response = await request(app)
        .post('/api/matches')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          stakeAmount: 100,
          token: 'XLM',
          gameId: 'lichess-game-abc123',
          platform: 'lichess',
        });

      // Should not get 401, should proceed to validate request body
      expect(response.status).not.toBe(401);
    });

    it('extracts address from JWT and uses it as player1', async () => {
      mockLichessGameFound('lichess-game-xyz789');
      const player1Address = 'GPLAYER1CUSTOM1111111111111111111111111111111111111111';
      const token = jwt.sign({ address: player1Address }, secret, { expiresIn: '1h' });

      const response = await request(app)
        .post('/api/matches')
        .set('Authorization', `Bearer ${token}`)
        .send({
          player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          stakeAmount: 100,
          token: 'XLM',
          gameId: 'lichess-game-xyz789',
          platform: 'lichess',
        });

      expect(response.status).toBe(201);
      expect(response.body.player1).toBe(player1Address);
    });
  });
});
