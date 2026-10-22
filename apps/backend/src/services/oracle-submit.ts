/**
 * Oracle submission service with exponential backoff retry logic.
 *
 * This service submits chess game results to the Stellar blockchain with automatic
 * retry on transient failures. Failed submissions are written to a dead-letter queue
 * after max retries are exhausted, where they remain for manual inspection and retry.
 *
 * Implements idempotent submission: if a result already exists on-chain for a match_id,
 * the submission is skipped and logged as informational, not an error.
 *
 * Configurable via environment variables:
 * - ORACLE_MAX_RETRIES: Maximum number of retry attempts (default: 5)
 * - ORACLE_RETRY_BASE_MS: Base interval for exponential backoff in milliseconds (default: 1000)
 * - ORACLE_RETRY_MAX_MS: Maximum interval between retries in milliseconds (default: 60000)
 */

import logger from '../logger.js';
import { DlqEntry, writeToDlq } from '../queue.js';

/** Configuration for retry behavior. */
export interface RetryConfig {
  /** Maximum number of retry attempts before writing to DLQ. */
  maxRetries: number;
  /** Base interval (ms) for exponential backoff: delay = base * (2 ^ attempt). */
  baseDelayMs: number;
  /** Maximum interval (ms) between retries; prevents unbounded growth. */
  maxDelayMs: number;
}

/** Submission details sent to the retry handler. */
export interface OracleSubmission {
  /** Escrow match ID. */
  matchId: number;
  /** Chess platform game ID. */
  gameId: string;
  /** Game outcome. */
  result: 'Player1Wins' | 'Player2Wins' | 'Draw';
}

/** Handler to check if a result already exists on-chain. */
export type ExistenceChecker = (matchId: number) => Promise<boolean>;

/** Result of a submission attempt. */
export interface SubmissionAttempt {
  /** Whether the attempt succeeded. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
  /** Retry delay (ms) for the next attempt if failed. */
  nextRetryDelayMs?: number;
}

/** Load retry configuration from environment. */
export function loadRetryConfig(): RetryConfig {
  return {
    maxRetries: parseInt(process.env.ORACLE_MAX_RETRIES ?? '5', 10),
    baseDelayMs: parseInt(process.env.ORACLE_RETRY_BASE_MS ?? '1000', 10),
    maxDelayMs: parseInt(process.env.ORACLE_RETRY_MAX_MS ?? '60000', 10),
  };
}

/**
 * Calculate exponential backoff delay for a given attempt number.
 *
 * Formula: delay = min(baseDelayMs * (2 ^ attempt), maxDelayMs)
 * Example (base=1000, max=60000):
 *   attempt 0: 1000ms (1s)
 *   attempt 1: 2000ms (2s)
 *   attempt 2: 4000ms (4s)
 *   attempt 3: 8000ms (8s)
 *   attempt 4: 16000ms (16s)
 *   attempt 5: 32000ms (32s)
 *   attempt 6+: 60000ms (60s, capped)
 */
export function calculateBackoffDelay(
  attempt: number,
  config: RetryConfig
): number {
  const exponential = config.baseDelayMs * Math.pow(2, attempt);
  return Math.min(exponential, config.maxDelayMs);
}

/**
 * Submit a chess result to the Stellar blockchain with exponential backoff retry.
 *
 * On transient failures (RPC timeout, fee bump needed, sequence number stale),
 * retries with exponential backoff up to maxRetries times. After all retries are
 * exhausted, the submission is written to the dead-letter queue for manual inspection.
 *
 * @param submission - The result to submit
 * @param handler - Async function to execute the actual blockchain submission
 * @param config - Retry configuration
 * @returns A DLQ entry if written, undefined if successful or still retrying
 */
export async function submitWithRetry(
  submission: OracleSubmission,
  handler: (sub: OracleSubmission) => Promise<void>,
  config: RetryConfig
): Promise<DlqEntry | undefined> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      await handler(submission);
      if (attempt > 0) {
        logger.info(
          { matchId: submission.matchId, attempt },
          'oracle_submit: success after retries'
        );
      }
      return undefined;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      if (attempt < config.maxRetries) {
        const nextDelay = calculateBackoffDelay(attempt + 1, config);
        logger.warn(
          {
            matchId: submission.matchId,
            attempt,
            nextRetryDelayMs: nextDelay,
            error: lastError.message,
          },
          'oracle_submit: transient failure, will retry'
        );
        await sleep(calculateBackoffDelay(attempt, config));
      }
    }
  }

  // All retries exhausted — write to DLQ
  const dlqEntry = await writeToDlq(submission, lastError?.message ?? 'Unknown error');
  logger.error(
    {
      matchId: submission.matchId,
      dlqId: dlqEntry.id,
      attempts: config.maxRetries + 1,
      lastError: lastError?.message,
    },
    'oracle_submit: exhausted retries, written to DLQ'
  );
  return dlqEntry;
}

/**
 * Retry a previously failed submission from the dead-letter queue.
 *
 * Attempts the submission once with no retry logic. If it fails again,
 * the entry remains in the DLQ for the next retry cycle.
 *
 * @param entry - DLQ entry to retry
 * @param handler - Async function to execute the blockchain submission
 * @returns true if successful (entry should be removed from DLQ), false if it failed
 */
export async function retryDlqEntry(
  entry: DlqEntry,
  handler: (sub: OracleSubmission) => Promise<void>
): Promise<boolean> {
  try {
    const submission = entry.payload as OracleSubmission;
    await handler(submission);
    logger.info(
      { dlqId: entry.id, totalAttempts: entry.attempts },
      'oracle_submit: DLQ entry resolved'
    );
    return true;
  } catch (err) {
    logger.warn(
      {
        dlqId: entry.id,
        attempt: entry.attempts,
        error: err instanceof Error ? err.message : String(err),
      },
      'oracle_submit: DLQ retry failed'
    );
    return false;
  }
}

/**
 * Submit a result to the oracle contract with idempotence support.
 *
 * Before attempting to submit, checks if a result already exists for this match_id.
 * If yes, logs as informational and returns success (idempotent).
 * If no, attempts submission with exponential backoff retry.
 *
 * This protects against duplicate submissions when the oracle service crashes and
 * restarts mid-submission cycle.
 *
 * @param submission - The result to submit
 * @param handler - Async function to execute the actual blockchain submission
 * @param existenceChecker - Async function to check if result already exists on-chain
 * @param config - Retry configuration
 * @returns A DLQ entry if written, undefined if successful (including idempotent skips)
 */
export async function submitWithIdempotence(
  submission: OracleSubmission,
  handler: (sub: OracleSubmission) => Promise<void>,
  existenceChecker: ExistenceChecker,
  config: RetryConfig
): Promise<DlqEntry | undefined> {
  try {
    const alreadyExists = await existenceChecker(submission.matchId);
    if (alreadyExists) {
      logger.info(
        { matchId: submission.matchId, gameId: submission.gameId },
        'oracle_submit: result already exists on-chain, skipping'
      );
      return undefined;
    }
  } catch (err) {
    logger.warn(
      {
        matchId: submission.matchId,
        error: err instanceof Error ? err.message : String(err),
      },
      'oracle_submit: existence check failed, proceeding with submission'
    );
    // Continue with submission attempt even if existence check fails
  }

  return submitWithRetry(submission, handler, config);
}

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The escrow contract's submit_result starts its dispute window. The separate
// oracle registry does not transition escrow, so settlements target escrow directly.
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { MatchRecord } from "../store/match-store.js";
import type {
  SettlementRecord,
  SettlementStore,
} from "../store/settlement-store.js";

export interface ChainMatch {
  id: bigint;
  game_id: string;
  player1: string;
  player2: string;
  platform: string[];
  state: string[];
}

export interface SettlementClient {
  getMatch(matchId: number): Promise<ChainMatch>;
  prepare(
    submission: OracleSubmission,
  ): Promise<NonNullable<SettlementRecord["transaction"]>>;
  send(envelope: string): Promise<void>;
  status(hash: string): Promise<"SUCCESS" | "FAILED" | "NOT_FOUND">;
}

export class SorobanSettlementClient implements SettlementClient {
  readonly server: rpc.Server;
  readonly signer: Keypair;
  readonly contract: Contract;
  constructor(
    readonly config: {
      rpcUrl: string;
      networkPassphrase: string;
      secretKey: string;
      escrowContract: string;
    },
  ) {
    this.signer = Keypair.fromSecret(config.secretKey);
    this.contract = new Contract(config.escrowContract);
    const url = new URL(config.rpcUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !local)
      throw new Error("Insecure RPC is only allowed on loopback");
    this.server = new rpc.Server(config.rpcUrl, {
      allowHttp: local,
      timeout: 10_000,
    });
  }

  static fromEnvironment(): SorobanSettlementClient {
    const required = (name: string): string => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} is required for oracle settlement`);
      return value;
    };
    return new SorobanSettlementClient({
      rpcUrl: required("STELLAR_RPC_URL"),
      networkPassphrase: required("STELLAR_NETWORK_PASSPHRASE"),
      secretKey: required("ORACLE_SECRET_KEY"),
      escrowContract: required("CONTRACT_ESCROW"),
    });
  }

  private async build(operation: xdr.Operation) {
    const account = await this.server.getAccount(this.signer.publicKey());
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(120)
      .build();
  }

  async getMatch(matchId: number): Promise<ChainMatch> {
    const tx = await this.build(
      this.contract.call(
        "get_match",
        nativeToScVal(BigInt(matchId), { type: "u64" }),
      ),
    );
    const simulation = await this.server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new Error("Unable to read escrow match");
    }
    return scValToNative(simulation.result.retval) as ChainMatch;
  }

  async prepare(submission: OracleSubmission) {
    const winner = {
      Player1Wins: "Player1",
      Player2Wins: "Player2",
      Draw: "Draw",
    }[submission.result];
    const tx = await this.server.prepareTransaction(
      await this.build(
        this.contract.call(
          "submit_result",
          nativeToScVal(BigInt(submission.matchId), { type: "u64" }),
          nativeToScVal(submission.gameId, { type: "string" }),
          xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(winner)]),
          new Address(this.signer.publicKey()).toScVal(),
        ),
      ),
    );
    tx.sign(this.signer);
    return {
      hash: tx.hash().toString("hex"),
      envelope: tx.toXDR(),
      expiresAt: Number(tx.timeBounds!.maxTime) * 1000,
    };
  }

  async send(envelope: string): Promise<void> {
    const response = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(envelope, this.config.networkPassphrase),
    );
    if (response.status === "ERROR")
      throw new Error("Soroban rejected transaction; reconciliation required");
  }

  async status(hash: string) {
    return (await this.server.getTransaction(hash)).status;
  }
}

export function assertChainBinding(
  match: MatchRecord,
  chain: ChainMatch,
): void {
  const platform =
    match.platform === "lichess"
      ? "Lichess"
      : match.platform === "chessdotcom"
        ? "ChessDotCom"
        : undefined;
  if (
    chain.id !== BigInt(match.matchId) ||
    chain.game_id !== match.gameId ||
    chain.player1 !== match.player1 ||
    chain.player2 !== match.player2 ||
    !platform ||
    chain.platform[0] !== platform
  ) {
    throw new Error(
      "Persisted match does not match escrow identity, game, or platform",
    );
  }
}

/** One step of the durable outbox. A hash and signed envelope are committed
 * before broadcast. Unknown outcomes only rebroadcast identical bytes (same hash).
 * Expired unknown transactions are retained for operator reconciliation, never
 * replaced automatically with a fresh transaction that could settle twice. */
export async function advanceSettlement(
  store: SettlementStore,
  client: SettlementClient,
  record: SettlementRecord,
): Promise<void> {
  if (
    record.state === "confirmed" ||
    record.state === "quarantined" ||
    !record.submission
  )
    return;
  if (!record.transaction) {
    record.transaction = await client.prepare(record.submission);
    record.state = "submitted";
    await store.save(record);
  }
  const status = await client.status(record.transaction.hash);
  record.chainStatus = status;
  if (status === "SUCCESS") {
    record.state = "confirmed";
    record.error = undefined;
  } else if (status === "FAILED") {
    record.state = "quarantined";
    record.error = "Transaction failed on-chain; manual review required";
  } else if (Date.now() >= record.transaction.expiresAt) {
    record.state = "quarantined";
    record.error =
      "Expired transaction with uncertain outcome; reconcile hash and escrow before manual retry";
  } else {
    // Persist the status before a send that might time out after committing.
    await store.save(record);
    await client.send(record.transaction.envelope);
    record.chainStatus = await client.status(record.transaction.hash);
    if (record.chainStatus === "SUCCESS") {
      record.state = "confirmed";
      record.error = undefined;
    }
    if (record.chainStatus === "FAILED") {
      record.state = "quarantined";
      record.error = "Transaction failed on-chain; manual review required";
    }
  }
  await store.save(record);
}
