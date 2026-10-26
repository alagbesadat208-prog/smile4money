import axios, { type AxiosInstance } from "axios";
import http from "node:http";
import https from "node:https";
import { RpcTimeoutError } from "../errors/RpcTimeoutError.js";
import { traceHeaders } from "../tracing/trace-context.js";

const DEFAULT_RPC_POOL_SIZE = 10;
const DEFAULT_RPC_KEEP_ALIVE_TIMEOUT_MS = 5_000;

/**
 * Default timeout for any Soroban RPC call that doesn't set its own
 * shorter, purpose-specific override (#1718). A hanging RPC node must never
 * be able to block a backend worker indefinitely, so this is applied at the
 * axios-instance level -- every request through `stellarRpcClient` is bounded
 * even if a future call site forgets to pass a per-request `timeout`.
 */
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

export interface StellarRpcClientOptions {
  poolSize?: number;
  keepAliveTimeoutMs?: number;
  timeoutMs?: number;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getRpcClientOptions(): Required<StellarRpcClientOptions> {
  return {
    poolSize: readPositiveInteger(
      process.env.STELLAR_RPC_POOL_SIZE,
      DEFAULT_RPC_POOL_SIZE,
    ),
    keepAliveTimeoutMs: readPositiveInteger(
      process.env.STELLAR_RPC_KEEP_ALIVE_TIMEOUT_MS,
      DEFAULT_RPC_KEEP_ALIVE_TIMEOUT_MS,
    ),
    timeoutMs: readPositiveInteger(
      process.env.STELLAR_RPC_TIMEOUT_MS,
      DEFAULT_RPC_TIMEOUT_MS,
    ),
  };
}

/**
 * Adds the active W3C trace context (#123) to every RPC request, so oracle
 * submissions and ledger reads made from a DLQ retry or polling job show up
 * in the same trace as the request that queued them.
 */
function withTraceHeaders(client: AxiosInstance): AxiosInstance {
  client.interceptors?.request.use((config) => {
    const headers = traceHeaders();
    for (const [name, value] of Object.entries(headers)) {
      config.headers?.set?.(name, value);
    }
    return config;
  });
  return client;
}

export function createStellarRpcClient(
  options: StellarRpcClientOptions = getRpcClientOptions(),
): AxiosInstance {
  const poolSize = options.poolSize ?? DEFAULT_RPC_POOL_SIZE;
  const keepAliveTimeoutMs =
    options.keepAliveTimeoutMs ?? DEFAULT_RPC_KEEP_ALIVE_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  return withTraceHeaders(axios.create({
    timeout: timeoutMs,
    httpAgent: new http.Agent({
      keepAlive: true,
      maxSockets: poolSize,
      keepAliveMsecs: keepAliveTimeoutMs,
    }),
    httpsAgent: new https.Agent({
      keepAlive: true,
      maxSockets: poolSize,
      keepAliveMsecs: keepAliveTimeoutMs,
    }),
  }));
}

const resolvedRpcClientOptions = getRpcClientOptions();
const stellarRpcClient = createStellarRpcClient(resolvedRpcClientOptions);

/**
 * Timeout (ms) for `checkStellarRpc`'s health-check request specifically.
 * Kept independently configurable and shorter than the general RPC default
 * so a slow/unresponsive RPC node can't block the health endpoint itself
 * (#45) -- callers hitting `/health` need a fast answer even when the RPC
 * node is degraded, not the full 10s the general default budget allows.
 */
const HEALTH_CHECK_TIMEOUT_MS = readPositiveInteger(
  process.env.STELLAR_RPC_HEALTH_TIMEOUT_MS,
  3_000,
);

/**
 * Runs a Soroban RPC call and translates axios's generic timeout error
 * (`ECONNABORTED`) into a typed {@link RpcTimeoutError}, so callers can
 * distinguish "the RPC node didn't respond in time" from any other network
 * or RPC-level failure instead of getting an unhandled/generic rejection
 * (#1718).
 */
async function withRpcTimeoutTranslation<T>(
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (axios.isAxiosError(error) && error.code === "ECONNABORTED") {
      throw new RpcTimeoutError(
        `Stellar RPC request timed out after ${timeoutMs}ms`,
        timeoutMs,
      );
    }
    throw error;
  }
}

export async function checkStellarRpc(): Promise<void> {
  const rpcUrl = process.env.STELLAR_RPC_URL;
  if (!rpcUrl) {
    throw new Error("STELLAR_RPC_URL not configured");
  }

  const response = await withRpcTimeoutTranslation(HEALTH_CHECK_TIMEOUT_MS, () =>
    stellarRpcClient.post(
      rpcUrl,
      {
        method: "get health",
        params: [],
        id: 1,
        jsonrpc: "2.0",
      },
      {
        // Bounded independently of other RPC calls so a slow/unresponsive RPC
        // can't block the health endpoint itself (#45).
        timeout: HEALTH_CHECK_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
        },
      },
    ),
  );

  if (response.status !== 200 || !response.data || response.data.error) {
    throw new Error("Stellar RPC unavailable");
  }
}

/**
 * Fetch the current ledger sequence number from the Soroban RPC (#51).
 *
 * Used to detect a match that has been Active longer than the escrow
 * contract's on-chain `timeout_ledgers` window, at which point no further
 * payout is possible and polling should stop.
 */
export async function getCurrentLedger(): Promise<number> {
  const rpcUrl = process.env.STELLAR_RPC_URL;
  if (!rpcUrl) {
    throw new Error("STELLAR_RPC_URL not configured");
  }

  const response = await withRpcTimeoutTranslation(
    resolvedRpcClientOptions.timeoutMs,
    () =>
      stellarRpcClient.post(
        rpcUrl,
        {
          method: "getLatestLedger",
          params: [],
          id: 1,
          jsonrpc: "2.0",
        },
        {
          // No per-call override: inherits the instance-level default
          // (STELLAR_RPC_TIMEOUT_MS, 10s) set on stellarRpcClient (#1718).
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
  );

  const sequence = response.data?.result?.sequence;
  if (response.status !== 200 || !response.data || response.data.error || typeof sequence !== "number") {
    throw new Error("Failed to fetch current ledger from Stellar RPC");
  }

  return sequence;
}
