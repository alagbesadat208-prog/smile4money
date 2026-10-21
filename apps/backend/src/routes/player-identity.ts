import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  confirmIdentityLink,
  createIdentityLinkChallenge,
} from '../services/player-identity.js';

const router = Router();
router.use(authenticate);

router.post('/challenge', (req, res) => {
  const { platform, username } = req.body ?? {};
  if (!req.address)
    return res
      .status(401)
      .json({ error: 'Authenticated wallet address is required' });
  try {
    const challenge = createIdentityLinkChallenge(
      req.address,
      platform,
      username,
    );
    return res.status(200).json(challenge);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid link request',
    });
  }
});

router.post('/confirm', (req, res) => {
  const { nonce, signature } = req.body ?? {};
  if (typeof nonce !== 'string' || typeof signature !== 'string') {
    return res.status(400).json({ error: 'nonce and signature are required' });
  }
  if (!req.address)
    return res
      .status(401)
      .json({ error: 'Authenticated wallet address is required' });
  if (!confirmIdentityLink(nonce, req.address, signature)) {
    return res.status(400).json({
      error: 'Invalid, expired, replayed, or wrong-wallet identity proof',
    });
  }
  return res.status(200).json({ linked: true });
});

export default router;
