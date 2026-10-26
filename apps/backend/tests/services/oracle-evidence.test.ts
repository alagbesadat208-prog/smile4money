import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MatchStore } from '../../src/store/match-store.js';
import { SqliteEvidenceStore } from '../../src/store/evidence-store.js';
import { verifyGameResult } from '../../src/services/oracle-service.js';
import { createReviewRouter } from '../../src/routes/oracle-review.js';
import { PollingJobStore, PollingWorker } from '../../src/services/polling.js';
import { ChessPlatformPoller } from '../../src/services/game-poller.js';
vi.mock('axios');
const get = vi.mocked(axios.get);
const payload = {
  id: 'game',
  status: 'mate',
  winner: 'white',
  lastMoveAt: 1700000000000,
  players: {
    white: { user: { name: 'alice' } },
    black: { user: { name: 'bob' } },
  },
};
let directory: string;
let ledger: SqliteEvidenceStore;
let matches: MatchStore;
const input = { matchId: 0, gameId: 'game', platform: 'lichess' };
const token = (address: string) =>
  jwt.sign({ address }, process.env.JWT_SECRET || 'test-secret');
function app() {
  const server = express();
  server.use(express.json());
  server.use('/reviews', createReviewRouter(ledger));
  return server;
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('ORACLE_ADMIN_ADDRESSES', 'operator');
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-evidence-'));
  ledger = new SqliteEvidenceStore(path.join(directory, 'evidence.db'));
  await ledger.initialize();
  matches = new MatchStore();
  await matches.createMatch({
    player1: 'G1',
    player2: 'G2',
    player1Username: 'alice',
    player2Username: 'bob',
    gameId: 'game',
    platform: 'lichess',
    stakeAmount: 10,
    token: 'XLM',
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await ledger.close();
  await fs.rm(directory, { recursive: true });
});
describe('durable oracle evidence and operator review', () => {
  it('retains progress and verified provenance across restart and returns the durable decision reference', async () => {
    get
      .mockResolvedValueOnce({
        status: 200,
        data: { ...payload, status: 'started', winner: undefined },
      })
      .mockResolvedValue({ status: 200, data: payload });
    expect((await verifyGameResult(matches, input, ledger)).ok).toBe(true);
    const result = await verifyGameResult(matches, input, ledger);
    expect(result.ok).toBe(true);
    await ledger.close();
    ledger = new SqliteEvidenceStore(path.join(directory, 'evidence.db'));
    await ledger.initialize();
    const history = await ledger.history('game');
    expect(history.map((d) => d.state)).toEqual(['in_progress', 'verified']);
    expect(history[1].evidence).toMatchObject({
      provider: 'lichess',
      parserVersion: '2',
      outcome: 'Player1Wins',
      fetchedAt: expect.stringMatching(/Z$/),
    });
    if (result.ok) expect(history[1].id).toBe(result.decisionId);
    expect(JSON.stringify(history)).not.toMatch(/alice|bob|players|pgn/);
  });
  it('holds ambiguous evidence across restarts, blocks automatic retries, and only permits administrator re-verification', async () => {
    get.mockResolvedValue({
      status: 200,
      data: { ...payload, winner: undefined },
    });
    expect(await verifyGameResult(matches, input, ledger)).toMatchObject({
      ok: false,
      status: 409,
    });
    await ledger.close();
    ledger = new SqliteEvidenceStore(path.join(directory, 'evidence.db'));
    await ledger.initialize();
    await verifyGameResult(matches, input, ledger);
    expect(get).toHaveBeenCalledTimes(1);
    expect((await ledger.history('game'))[0]).toMatchObject({
      state: 'review_required',
      reason: 'Terminal game has no valid outcome',
      evidence: { responseHash: expect.any(String) },
    });
    expect((await request(app()).get('/reviews/game')).status).toBe(401);
    expect(
      (
        await request(app())
          .get('/reviews/game')
          .set('Authorization', `Bearer ${token('player')}`)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app())
          .get('/reviews/game')
          .set('Authorization', `Bearer ${token('operator')}`)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app())
          .post('/reviews/game/retry')
          .set('Authorization', `Bearer ${token('operator')}`)
          .send({ reason: 'checked', result: 'Draw' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app())
          .post('/reviews/game/retry')
          .set('Authorization', `Bearer ${token('player')}`)
          .send({ reason: 'checked' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app())
          .post('/reviews/game/retry')
          .set('Authorization', `Bearer ${token('operator')}`)
          .send({ reason: 'Provider corrected evidence' })
      ).status,
    ).toBe(200);
    get.mockResolvedValue({ status: 200, data: payload });
    expect((await verifyGameResult(matches, input, ledger)).ok).toBe(true);
    const history = await ledger.history('game');
    expect(history.map((d) => d.state)).toEqual([
      'review_required',
      'retry_requested',
      'verified',
    ]);
    expect(history[1].operator).toBe('operator');
  });
  it('quarantines changed outcomes while retaining the earlier verified decision', async () => {
    get
      .mockResolvedValueOnce({ status: 200, data: payload })
      .mockResolvedValue({
        status: 200,
        data: { ...payload, winner: 'black' },
      });
    await verifyGameResult(matches, input, ledger);
    expect(await verifyGameResult(matches, input, ledger)).toMatchObject({
      status: 409,
    });
    expect(
      (await ledger.history('game')).map((d) => d.evidence?.outcome),
    ).toEqual(['Player1Wins', 'Player2Wins']);
  });
  it('stops polling quarantined jobs without submission or retry/DLQ callbacks', async () => {
    get.mockResolvedValue({
      status: 200,
      data: { ...payload, winner: undefined },
    });
    const jobs = new PollingJobStore();
    jobs.createJob(0, 'game', 'lichess');
    const completed = vi.fn();
    const dlq = vi.fn();
    const worker = new PollingWorker(
      jobs,
      new ChessPlatformPoller(matches, ledger),
      { onGameCompleted: completed, onMaxAttemptsExceeded: dlq },
    );
    worker.start();
    await worker.stop();
    expect(jobs.listPendingJobs()).toHaveLength(0);
    expect(completed).not.toHaveBeenCalled();
    expect(dlq).not.toHaveBeenCalled();
    expect((await ledger.history('game'))[0].state).toBe('review_required');
  });
  it('carries the persisted decision reference into the completion callback', async () => {
    get.mockResolvedValue({ status: 200, data: payload });
    const jobs = new PollingJobStore();
    jobs.createJob(0, 'game', 'lichess');
    const completed = vi.fn();
    const worker = new PollingWorker(
      jobs,
      new ChessPlatformPoller(matches, ledger),
      { onGameCompleted: completed, onMaxAttemptsExceeded: vi.fn() },
    );
    worker.start();
    await worker.stop();
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({ gameId: 'game' }),
      'Player1Wins',
      (await ledger.history('game'))[0].id,
    );
  });
  it('serializes overlapping verification requests so a review hold cannot be automatically bypassed', async () => {
    get.mockResolvedValue({
      status: 200,
      data: { ...payload, winner: undefined },
    });
    const outcomes = await Promise.all([
      verifyGameResult(matches, input, ledger),
      verifyGameResult(matches, input, ledger),
    ]);
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 409 }),
      expect.objectContaining({ status: 409 }),
    ]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(await ledger.history('game')).toHaveLength(1);
  });
  it('does not return a verified result if provenance cannot be persisted', async () => {
    get.mockResolvedValue({ status: 200, data: payload });
    vi.spyOn(ledger, 'append').mockRejectedValueOnce(new Error('disk full'));
    await expect(verifyGameResult(matches, input, ledger)).rejects.toThrow(
      'disk full',
    );
    expect(await ledger.history('game')).toHaveLength(0);
  });
  it('denies operator access with an empty allowlist', async () => {
    vi.stubEnv('ORACLE_ADMIN_ADDRESSES', '');
    expect(
      (
        await request(app())
          .get('/reviews/game')
          .set('Authorization', `Bearer ${token('operator')}`)
      ).status,
    ).toBe(403);
  });
});
