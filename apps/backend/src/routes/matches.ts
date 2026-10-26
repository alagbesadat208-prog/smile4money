import { unlinkPlayerIdentities } from '../services/player-identity.js';
import { Router } from 'express';
import { matchStore } from '../store/index.js';
import { authenticate } from '../middleware/auth.js';
import {
  validateCreateMatchInput,
  createMatchForPlayer,
} from '../services/match-service.js';
import {
  ErrorCode,
  errorEnvelope,
  statusToErrorCode,
} from '../errors/errorResponse.js';

const router = Router();
const store = matchStore;

router.use(authenticate);

router.delete('/identities', async (req, res, next) => {
  try {
    await unlinkPlayerIdentities(store, req.address!);
    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res) => {
  const payload = req.body;
  const player1 = req.address;

  if (!player1) {
    return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Authentication required'));
  }

  if (!payload || typeof payload !== 'object') {
    return res
      .status(400)
      .json(
        errorEnvelope(ErrorCode.VALIDATION_ERROR, 'Request body must be JSON'),
      );
  }

  // Validate input fields before calling the service
  const validationError = validateCreateMatchInput(player1, payload);
  if (validationError) {
    return res
      .status(400)
      .json(errorEnvelope(ErrorCode.VALIDATION_ERROR, validationError));
  }

  const result = await createMatchForPlayer(store, player1, {
    player2: payload.player2,
    stakeAmount: payload.stakeAmount,
    token: payload.token,
    gameId: payload.gameId,
    platform: payload.platform,
    username:
      typeof payload.username === 'string' ? payload.username : undefined,
  });

  if (!result.ok) {
    const message = result.details
      ? `${result.error}: ${result.details}`
      : result.error;
    return res
      .status(result.status)
      .json(errorEnvelope(statusToErrorCode(result.status), message));
  }

  return res.status(201).json(result.match);
});

export default router;
