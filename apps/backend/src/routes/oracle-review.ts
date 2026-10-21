import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { evidenceStore } from '../store/index.js';
import { withGameLock, type EvidenceStore } from '../store/evidence-store.js';

export function createReviewRouter(ledger: EvidenceStore) {
  const router = Router();
  router.use(authenticate);
  router.use((req, res, next) => {
    const operators = (process.env.ORACLE_ADMIN_ADDRESSES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!req.address || !operators.includes(req.address))
      return res.status(403).json({ error: 'Administrator required' });
    next();
  });
  router.get('/:gameId', async (req, res, next) => {
    try {
      const history = await ledger.history(req.params.gameId);
      if (!history.length)
        return res.status(404).json({ error: 'Evidence not found' });
      res.json({ history });
    } catch (error) {
      next(error);
    }
  });
  // Only permit re-fetching evidence. No winner override, transaction signing or contract call.
  router.post('/:gameId/retry', async (req, res, next) => {
    if (
      !req.body ||
      Object.keys(req.body).some((k) => k !== 'reason') ||
      typeof req.body.reason !== 'string' ||
      !req.body.reason.trim() ||
      req.body.reason.length > 500
    ) {
      return res
        .status(400)
        .json({ error: 'Provide only a reason (1–500 characters)' });
    }
    try {
      const decision = await withGameLock(req.params.gameId, async () => {
        const history = await ledger.history(req.params.gameId);
        const latest = history[history.length - 1];
        if (latest?.state !== 'review_required') return null;
        return ledger.append({
          matchId: latest.matchId,
          gameId: latest.gameId,
          state: 'retry_requested',
          reason: req.body.reason.trim(),
          operator: req.address,
          recordedAt: new Date().toISOString(),
        });
      });
      if (decision === null)
        return res.status(409).json({ error: 'Match is not awaiting review' });
      res.json({ decisionId: decision, state: 'retry_requested' });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
export default createReviewRouter(evidenceStore);
