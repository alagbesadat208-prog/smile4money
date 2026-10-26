/**
 * Health Service
 *
 * Contains the business logic for the health-check endpoint. The route
 * handler in routes/health.ts delegates here so the logic can be tested
 * independently of HTTP concerns.
 */

import { checkStellarRpc } from './stellar.js';
import { getAllLimiterStats } from './bottleneck-limiters.js';
import { getSettlementAgeMonitor, type SettlementSnapshot } from './settlement-age-monitor.js';

export interface HealthCheckOptions {
  /** When true, performs a live connectivity check against the Stellar RPC. */
  deepCheck?: boolean;
  /** When true, appends rate-limiter statistics to the response payload. */
  includeLimiters?: boolean;
  /** When true, appends settlement age percentiles and active alerts to the response payload. */
  includeSettlement?: boolean;
  /** Uptime in seconds (passed in from the route so the timer origin is preserved). */
  uptimeSeconds: number;
  /** Application version string. */
  version: string;
}

export interface HealthOk {
  ok: true;
  payload: {
    status: 'ok';
    uptime: number;
    version: string;
    dependencies?: { stellar_rpc: 'ok' };
    limiters?: ReturnType<typeof getAllLimiterStats>;
    settlement?: SettlementSnapshot | null;
  };
}

export interface HealthError {
  ok: false;
  payload: {
    status: 'error';
    uptime: number;
    version: string;
    error: string;
    dependencies: { stellar_rpc: 'unreachable' };
  };
}

export type HealthCheckResult = HealthOk | HealthError;

/**
 * Execute the health-check logic.
 *
 * When `deepCheck` is true, makes a live call to the Stellar RPC. If the
 * call fails the returned result has `ok: false` and the route handler should
 * respond with HTTP 503.
 *
 * When `includeLimiters` is true the response payload includes Bottleneck
 * limiter statistics (queued / executing counts).
 */
export async function runHealthCheck(options: HealthCheckOptions): Promise<HealthCheckResult> {
  const { deepCheck, includeLimiters, includeSettlement, uptimeSeconds, version } = options;

  if (deepCheck) {
    try {
      await checkStellarRpc();
    } catch (error) {
      return {
        ok: false,
        payload: {
          status: 'error',
          uptime: uptimeSeconds,
          version,
          error: error instanceof Error ? error.message : 'rpc unreachable',
          dependencies: { stellar_rpc: 'unreachable' },
        },
      };
    }
  }

  const payload: HealthOk['payload'] = {
    status: 'ok',
    uptime: uptimeSeconds,
    version,
  };

  if (deepCheck) {
    payload.dependencies = { stellar_rpc: 'ok' };
  }

  if (includeLimiters) {
    payload.limiters = getAllLimiterStats();
  }

  if (includeSettlement) {
    payload.settlement = getSettlementAgeMonitor()?.getSnapshot() ?? null;
  }

  return { ok: true, payload };
}
