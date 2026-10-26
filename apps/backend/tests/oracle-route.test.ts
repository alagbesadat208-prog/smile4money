/**
 * Tests for the oracle /submit-result route.
 *
 * Focused on the match-not-found paths, specifically distinguishing between:
 * - gameId unknown but store has other records (regular 404)
 * - store completely empty (persistence-loss suspected 404)
 */

import request from 'supertest';
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import oracleRouter from '../src/routes/oracle.js';
import { matchStore } from '../src/store/index.js';
import jwt from 'jsonwebtoken';

vi.mock('axios');

const secret = process.env.JWT_SECRET ?? 'test-secret';
const makeToken = (address = 'GORACLE1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') =>
  jwt.sign({ address }, secret, { expiresIn: '1h' });

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/oracle', oracleRouter);
  return app;
};

const VALID_BODY = {
  matchId: 1,
  gameId: 'lichess-game-abc123',
  platform: 'lichess',
};

beforeAll(async () => { await matchStore.initialize(); });
afterAll(async () => { await matchStore.close(); });
beforeEach(() => {
  matchStore.clear();
  vi.restoreAllMocks();
});

describe('POST /api/oracle/submit-result — match not found', () => {
  it('returns 404 with a generic message when gameId is unknown but store has records', async () => {
    // Seed a different match so the store is non-empty
    await matchStore.createMatch({
      player1: 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player2: 'GPLAYER2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player1Username: 'alice',
      player2Username: 'bob',
      stakeAmount: 100,
      token: 'XLM',
      gameId: 'some-other-game',
      platform: 'lichess',
    });

    const res = await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    // #50 — standard { error: { code, message } } envelope; the previous
    // separate `details` field is folded into error.message, and `hint`
    // (when present) lives at error.hint, not at the top level.
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toContain('Match not found');
    expect(res.body.error.message).toContain('lichess-game-abc123');
    // Must NOT carry the persistence-loss hint
    expect(res.body.error.hint).toBeUndefined();
  });

  it('returns 404 with a persistence-loss hint when the store is empty', async () => {
    // Store is already empty from beforeEach
    const res = await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toContain('Match not found');
    expect(res.body.error.hint).toBe('persistence_loss_suspected');
    expect(res.body.error.message).toMatch(/server may have restarted/i);
    expect(res.body.error.message).toMatch(/QUEUE_STORE/i);
  });

  it('logs oracle_match_not_found_empty_store at error level when store is empty', async () => {
    const logSpy = vi.spyOn(console, 'log');

    await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    const loggedMessages = logSpy.mock.calls
      .flatMap((args) => args)
      .map((arg) => {
        try { return JSON.parse(arg as string); } catch { return null; }
      })
      .filter(Boolean);

    const entry = loggedMessages.find(
      (m) => m.message === 'oracle_match_not_found_empty_store',
    );
    expect(entry).toBeDefined();
    expect(entry.level).toBe('error');
    expect(entry.game_id).toBe('lichess-game-abc123');
    expect(entry.store_count).toBe(0);
  });

  it('logs oracle_match_not_found at warn level when store has records', async () => {
    await matchStore.createMatch({
      player1: 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player2: 'GPLAYER2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player1Username: 'alice',
      player2Username: 'bob',
      stakeAmount: 100,
      token: 'XLM',
      gameId: 'some-other-game',
      platform: 'lichess',
    });

    const logSpy = vi.spyOn(console, 'log');

    await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    const loggedMessages = logSpy.mock.calls
      .flatMap((args) => args)
      .map((arg) => {
        try { return JSON.parse(arg as string); } catch { return null; }
      })
      .filter(Boolean);

    const entry = loggedMessages.find(
      (m) => m.message === 'oracle_match_not_found',
    );
    expect(entry).toBeDefined();
    expect(entry.level).toBe('warn');
    expect(entry.store_count).toBe(1);
  });
});

// #1717 — matchId must be validated as a positive integer before any
// downstream processing (store lookup, chess-platform API calls, Stellar
// transaction building).
describe('POST /api/oracle/submit-result — matchId validation', () => {
  it('returns 200 for a valid positive-integer matchId', async () => {
    await matchStore.createMatch({
      player1: 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player2: 'GPLAYER2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player1Username: 'alice',
      player2Username: 'bob',
      stakeAmount: 100,
      token: 'XLM',
      gameId: VALID_BODY.gameId,
      platform: 'lichess',
    });

    const res = await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    expect(res.status).not.toBe(400);
  });

  it.each([
    ['non-numeric string', 'not-a-number'],
    ['a float', 1.5],
    ['zero', 0],
    ['negative', -1],
  ])('returns 400 when matchId is %s', async (_label, matchId) => {
    const res = await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...VALID_BODY, matchId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('matchId must be a positive integer');
  });

  it('rejects an invalid matchId before touching the match store', async () => {
    const countSpy = vi.spyOn(matchStore, 'findByGameId');

    await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...VALID_BODY, matchId: -5 });

    expect(countSpy).not.toHaveBeenCalled();
  });
});
