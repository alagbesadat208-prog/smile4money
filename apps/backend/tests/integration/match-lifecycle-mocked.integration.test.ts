import { providerMetadata } from '../helpers/provider-metadata.js';
/**
 * Issue #48 (#1727) — Full match lifecycle integration test (fully mocked)
 *
 * Exercises the backend's actual role in the match lifecycle end-to-end —
 * create match → deposit × 2 → game result fetched → oracle verifies the
 * result — with both the chess-platform API and the Stellar Soroban RPC
 * mocked, so this test runs standalone with no live infrastructure. This is
 * distinct from the existing `match-lifecycle.integration.test.ts` and
 * `match-lifecycle-full.integration.test.ts`, which require a running local
 * Stellar node (and skip themselves entirely when one isn't configured).
 *
 * The backend has no on-chain contract-interaction layer of its own —
 * deposits and payouts happen on-chain, driven by the frontend/wallet
 * directly against the escrow contract (see README.md's Match State Machine
 * and docs/oracle.md's Result Submission Flow). `MatchRecord.state` is in
 * fact hardcoded to `'Pending'` in `store/match-store.ts` — the backend
 * never observes `Active`/`Completed` itself. This test therefore drives
 * the two REST endpoints the backend actually owns (create match, verify a
 * game result for the oracle) and tracks the on-chain escrow's documented
 * state machine and payout rule (README.md's state diagram, docs/oracle.md's
 * Result Types table: `Player1Wins` → full pot to player1) as an explicit,
 * clearly-labeled local simulation alongside those real calls — the shape a
 * real end-to-end run through the frontend + contract would actually take.
 *
 * Stack: Node.js · TypeScript · Vitest · supertest
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Mock the chess-platform API and the Stellar Soroban RPC so the whole flow
// runs fully offline.
// ---------------------------------------------------------------------------
vi.mock('../../src/fetchers/lichess.js', () => ({
  fetchLichessResult: vi.fn(),
  GameNotFoundError: class GameNotFoundError extends Error {},
}));

vi.mock('../../src/services/stellar.js', () => ({
  checkStellarRpc: vi.fn(),
}));

// Imported after the mocks are declared (vi.mock is hoisted).
import app from '../../src/app.js';
import { fetchLichessResult } from '../../src/fetchers/lichess.js';
import { checkStellarRpc } from '../../src/services/stellar.js';

const mockFetchLichessResult = vi.mocked(fetchLichessResult);
const mockCheckStellarRpc = vi.mocked(checkStellarRpc);

const PLAYER1 = 'GPLAYERONEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PLAYER2 = 'GPLAYERTWOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const TOKEN = 'CTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const GAME_ID = 'lifecycle-game-1';
const STAKE_AMOUNT = 100; // stroops, per player

function tokenFor(address: string): string {
  const secret = process.env.JWT_SECRET || 'test-secret';
  return jwt.sign({ address }, secret, { expiresIn: '1h' });
}

/**
 * A minimal, in-memory stand-in for the escrow contract's own state machine
 * and payout rule, since the backend neither implements nor queries the
 * contract itself (see file doc comment above). Mirrors, rather than
 * replaces, the documented on-chain behavior.
 */
class SimulatedEscrow {
  state: 'Pending' | 'Active' | 'Completed' = 'Pending';
  private player1Deposited = false;
  private player2Deposited = false;
  balances: Record<string, number> = { [PLAYER1]: 0, [PLAYER2]: 0 };

  deposit(player: string): void {
    if (this.state !== 'Pending') {
      throw new Error(`cannot deposit while match is ${this.state}`);
    }
    if (player === PLAYER1) this.player1Deposited = true;
    else if (player === PLAYER2) this.player2Deposited = true;
    if (this.player1Deposited && this.player2Deposited) {
      this.state = 'Active';
    }
  }

  submitResult(result: 'Player1Wins' | 'Player2Wins' | 'Draw'): void {
    if (this.state !== 'Active') {
      throw new Error(`cannot submit a result while match is ${this.state}`);
    }
    const pot = STAKE_AMOUNT * 2;
    if (result === 'Player1Wins') {
      this.balances[PLAYER1] += pot;
    } else if (result === 'Player2Wins') {
      this.balances[PLAYER2] += pot;
    } else {
      this.balances[PLAYER1] += STAKE_AMOUNT;
      this.balances[PLAYER2] += STAKE_AMOUNT;
    }
    this.state = 'Completed';
  }
}

describe('integration: full match lifecycle (create → deposit×2 → game result fetched → oracle submits)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DEEP_HEALTH;
  });

  it('walks a match through Pending → Active → Completed with the correct payout', async () => {
    // --- Pre-flight: confirm Stellar RPC connectivity (mocked) ---
    mockCheckStellarRpc.mockResolvedValue(undefined);
    process.env.DEEP_HEALTH = 'true';
    const healthResponse = await request(app).get('/health');
    expect(healthResponse.status).toBe(200);
    expect(mockCheckStellarRpc).toHaveBeenCalledOnce();
    delete process.env.DEEP_HEALTH;

    const escrow = new SimulatedEscrow();
    expect(escrow.state).toBe('Pending');

    // The game exists and is still in progress at match-creation time; the
    // mock resolves the same way for every call so match-creation's game
    // validation and the oracle's later identity check see consistent data.
    mockFetchLichessResult.mockResolvedValue({
      gameId: GAME_ID,
      ...providerMetadata('lichess', null),
      status: 'in_progress',
      whitePlayer: 'alice',
      blackPlayer: 'bob',
      result: null,
    });

    // --- 1. Create match (off-chain record; also validates the game exists
    //        and captures player identities for later oracle verification) ---
    const createResponse = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${tokenFor(PLAYER1)}`)
      .send({
        player2: PLAYER2,
        stakeAmount: STAKE_AMOUNT,
        token: TOKEN,
        gameId: GAME_ID,
        platform: 'lichess',
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.state).toBe('Pending');
    const matchId = createResponse.body.matchId;
    expect(typeof matchId).toBe('number');

    // --- 2. Deposit × 2 (on-chain in reality; simulated here) ---
    escrow.deposit(PLAYER1);
    expect(escrow.state).toBe('Pending'); // only one side has deposited so far
    escrow.deposit(PLAYER2);
    expect(escrow.state).toBe('Active'); // both sides deposited

    // --- 3. Game finishes; the oracle fetches and verifies the result ---
    mockFetchLichessResult.mockResolvedValue({
      gameId: GAME_ID,
      ...providerMetadata(),
      status: 'finished',
      whitePlayer: 'alice',
      blackPlayer: 'bob',
      result: 'Player1Wins',
    });

    const submitResponse = await request(app)
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${tokenFor(PLAYER1)}`)
      .send({
        matchId,
        gameId: GAME_ID,
        platform: 'lichess',
      });

    expect(submitResponse.status).toBe(200);
    expect(submitResponse.body.verified).toBe(true);
    expect(submitResponse.body.result).toBe('Player1Wins');

    // --- 4. Escrow pays out based on the oracle-verified result (simulated) ---
    escrow.submitResult(submitResponse.body.result);
    expect(escrow.state).toBe('Completed');
    expect(escrow.balances[PLAYER1]).toBe(STAKE_AMOUNT * 2);
    expect(escrow.balances[PLAYER2]).toBe(0);
  });

  it('splits the pot evenly on a draw', async () => {
    const escrow = new SimulatedEscrow();
    mockFetchLichessResult.mockResolvedValue({
      gameId: 'draw-game',
      ...providerMetadata('lichess', null),
      status: 'in_progress',
      whitePlayer: 'alice',
      blackPlayer: 'bob',
      result: null,
    });

    const createResponse = await request(app)
      .post('/api/matches')
      .set('Authorization', `Bearer ${tokenFor(PLAYER1)}`)
      .send({
        player2: PLAYER2,
        stakeAmount: STAKE_AMOUNT,
        token: TOKEN,
        gameId: 'draw-game',
        platform: 'lichess',
      });
    expect(createResponse.status).toBe(201);
    const matchId = createResponse.body.matchId;

    escrow.deposit(PLAYER1);
    escrow.deposit(PLAYER2);
    expect(escrow.state).toBe('Active');

    mockFetchLichessResult.mockResolvedValue({
      gameId: 'draw-game',
      ...providerMetadata('lichess', 'Draw'),
      status: 'finished',
      whitePlayer: 'alice',
      blackPlayer: 'bob',
      result: 'Draw',
    });

    const submitResponse = await request(app)
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${tokenFor(PLAYER1)}`)
      .send({ matchId, gameId: 'draw-game', platform: 'lichess' });

    expect(submitResponse.status).toBe(200);
    expect(submitResponse.body.result).toBe('Draw');

    escrow.submitResult('Draw');
    expect(escrow.state).toBe('Completed');
    expect(escrow.balances[PLAYER1]).toBe(STAKE_AMOUNT);
    expect(escrow.balances[PLAYER2]).toBe(STAKE_AMOUNT);
  });

  it('rejects an oracle submission before both players have deposited', () => {
    const escrow = new SimulatedEscrow();
    escrow.deposit(PLAYER1); // only one side
    expect(escrow.state).toBe('Pending');
    expect(() => escrow.submitResult('Player1Wins')).toThrow(/cannot submit a result while match is Pending/);
  });
});
