import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCircuitBreaker, type CircuitState } from '../services/circuit-breaker.js';
import { listDlqEntries } from '../queue.js';
import { buildStatus, loadIncidents } from '../services/status-service.js';

/**
 * GET /status: public, component-level service status and incidents (#115).
 * Unauthenticated and cacheable for 30 s. Never fails: a signal that can't
 * be read is reported as `unknown`. See docs/status-page.md.
 */
const router = Router();

const defaultIncidentsFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/status-incidents.json',
);

router.get('/', async (_req, res) => {
  let rpcCircuit: CircuitState | null = null;
  try {
    rpcCircuit = getCircuitBreaker().getState();
  } catch {
    rpcCircuit = null;
  }
  let pendingSubmissions: number | null = null;
  try {
    pendingSubmissions = (await listDlqEntries()).length;
  } catch {
    pendingSubmissions = null;
  }
  const status = buildStatus({
    rpcCircuit,
    pendingSubmissions,
    incidents: loadIncidents(process.env.STATUS_INCIDENTS_FILE || defaultIncidentsFile),
    now: new Date(),
  });
  res.set('Cache-Control', 'public, max-age=30');
  res.status(200).json(status);
});

export default router;
