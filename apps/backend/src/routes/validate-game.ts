import { Router } from 'express';
import { createRateLimitStore, createRateLimitMiddleware } from '../middleware/rate-limit.js';
import { validateGameInput, validateGame } from '../services/validate-game-service.js';
import { ErrorCode, errorEnvelope, statusToErrorCode } from '../errors/errorResponse.js';

const router = Router();

// Rate limiter: 100 requests per 60 seconds per IP. Backend (in-memory vs.
// shared SQLite) is chosen by RATE_LIMIT_STORE (#1723) — see
// middleware/rate-limit.ts#createRateLimitStore.
const rateLimitStore = await createRateLimitStore(100, 60 * 1000, 100);
router.use(createRateLimitMiddleware(rateLimitStore));

router.post('/', async (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json(errorEnvelope(ErrorCode.VALIDATION_ERROR, 'Request body must be JSON'));
  }

  const inputError = validateGameInput(payload);
  if (inputError) {
    return res.status(400).json(errorEnvelope(ErrorCode.VALIDATION_ERROR, inputError));
  }

  const result = await validateGame({
    gameId: payload.gameId,
    platform: payload.platform,
    username: typeof payload.username === 'string' ? payload.username : undefined,
  });

  if (!result.ok) {
    // This endpoint's failure body carries rich domain context
    // (valid/platform/gameId/legacyError) that existing consumers rely on,
    // so that shape is preserved; `error` is added alongside it, as the
    // standard { code, message } object (#50), rather than the old bare
    // string previously found under the same key.
    const message = result.message ?? result.error ?? 'Game validation failed';
    return res.status(result.status).json({
      valid: result.valid ?? false,
      platform: result.platform ?? payload.platform,
      gameId: result.gameId ?? payload.gameId,
      ...(result.message ? { message: result.message } : {}),
      // Machine-readable eligibility rejections (#110), when the game exists
      // but cannot be wagered on.
      ...('rejections' in result ? { rejections: result.rejections } : {}),
      error: errorEnvelope(statusToErrorCode(result.status), message).error,
    });
  }

  return res.status(200).json({
    valid: result.valid,
    platform: result.platform,
    gameId: result.gameId,
    status: result.status,
    whitePlayer: result.whitePlayer,
    blackPlayer: result.blackPlayer,
    result: result.result,
  });
});

export default router;
