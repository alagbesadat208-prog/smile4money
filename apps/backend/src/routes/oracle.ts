import type { DurableOracleWorker } from '../services/polling.js';
import { Router } from 'express';
import { matchStore } from '../store/index.js';
import { authenticate } from '../middleware/auth.js';
import { validateSubmitResultInput, verifyGameResult } from '../services/oracle-service.js';
import { errorToHttpStatus } from '../errors/errorToHttpStatus.js';
import { errorEnvelope, ErrorCode, statusToErrorCode } from '../errors/errorResponse.js';

const router = Router();
const store = matchStore;

// Oracle endpoints require authentication
router.use(authenticate);

/**
 * POST /api/oracle/submit-result
 *
 * Submit a verified game result to the oracle.
 *
 * Request body:
 * ```json
 * {
 *   "matchId": 1,
 *   "gameId": "abc123",
 *   "platform": "lichess",
 *   "username": "alice"  // Optional, required for Chess.com
 * }
 * ```
 *
 * This endpoint:
 * 1. Fetches the game result from the chess platform API
 * 2. Verifies that the players in the API response match the registered players
 * 3. Durably records and submits the signed escrow invocation
 * 4. Returns its transaction hash and chain status (202 while unconfirmed).
 */
router.post('/submit-result', async (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json(errorEnvelope(ErrorCode.VALIDATION_ERROR, 'Request body must be JSON'));
  }

  const inputError = validateSubmitResultInput(payload);
  if (inputError) {
    return res.status(400).json(errorEnvelope(ErrorCode.VALIDATION_ERROR, inputError));
  }

  try {
    const result = await verifyGameResult(req.app.locals.matchStore ?? store, {
      matchId: payload.matchId,
      gameId: payload.gameId,
      platform: payload.platform,
      username: typeof payload.username === 'string' ? payload.username : undefined,
    });

    if (!result.ok) {
      const message = result.details ? `${result.error}: ${result.details}` : result.error;
      const extra = result.hint ? { hint: result.hint } : undefined;
      return res.status(result.status).json(errorEnvelope(statusToErrorCode(result.status), message, extra));
    }

    const worker = req.app.locals.oracleWorker as DurableOracleWorker | undefined;
    if (!worker) {
      return res.status(503).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Oracle settlement worker unavailable'));
    }
    const settlement = await worker.submitVerified(payload, result);
    return res.status(settlement.state === 'confirmed' ? 200 : settlement.state === 'quarantined' ? 409 : 202).json({
      transactionHash: settlement.transaction?.hash,
      chainStatus: settlement.chainStatus,
      settlementState: settlement.state,
      verified: result.verified,
      matchId: result.matchId,
      gameId: result.gameId,
      result: result.result,
      whitePlayer: result.whitePlayer,
      blackPlayer: result.blackPlayer,
      status: result.status,
      message: result.message,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // #47 — mapped centrally so e.g. an upstream RateLimitError surfaces as
    // 429 here instead of always flattening to 500.
    return res.status(errorToHttpStatus(error)).json({
      error: 'Result verification failed',
      details: message,
    });
  }
});

export default router;
