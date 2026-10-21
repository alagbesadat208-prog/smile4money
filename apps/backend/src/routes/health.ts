import { Router } from 'express';
import { runHealthCheck } from '../services/health-service.js';

const router = Router();
const startTime = Date.now();

router.get('/', async (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const version = process.env.BACKEND_VERSION ?? process.env.npm_package_version ?? 'unknown';

  const result = await runHealthCheck({
    deepCheck: process.env.DEEP_HEALTH === 'true',
    includeLimiters: process.env.HEALTH_INCLUDE_LIMITERS === 'true',
    includeSettlement: process.env.HEALTH_INCLUDE_SETTLEMENT === 'true',
    uptimeSeconds,
    version,
  });

  if (!result.ok) {
    return res.status(503).json(result.payload);
  }

  return res.status(200).json(result.payload);
});

export default router;
