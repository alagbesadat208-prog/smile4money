import { verifyGameResult } from './oracle-service.js';
import type { MatchStore } from '../store/match-store.js';
import type { EvidenceStore } from '../store/evidence-store.js';
/**
 * Game poller implementation — bridges chess platform APIs to the polling worker.
 *
 * This module:
 * 1. Fetches game results from Lichess/Chess.com APIs
 * 2. Translates API responses to polling job status
 * 3. Handles API-specific logic (e.g. Chess.com username lookups)
 * 4. Distinguishes between "game in progress", "completed", and "error" states
 */

import { fetchLichessResult, GameNotFoundError } from '../fetchers/lichess.js';
import {
  fetchChessDotComResult,
  RateLimitError,
} from '../fetchers/chessdotcom.js';
import type { GamePoller, PollJob, PollJobStatus } from './polling.js';
import logger from '../logger.js';

/**
 * Create a game poller that fetches results from chess platform APIs.
 *
 * Handles:
 * - GameNotFoundError → 'failed' status (game deleted or invalid ID)
 * - API errors → 'failed' status (network, rate limiting, etc.)
 * - Game in progress (result === null) → 'in_progress' status
 * - Game completed (result !== null) → 'completed' status with result
 */
export class ChessPlatformPoller implements GamePoller {
  constructor(
    private matches?: Pick<MatchStore, 'findByGameId' | 'count'>,
    private evidence?: EvidenceStore,
  ) {}
  /**
   * Poll a single game and return its status.
   *
   * @returns PollJobStatus with status='in_progress', 'completed', or 'failed'
   */
  async poll(job: PollJob): Promise<PollJobStatus> {
    try {
      if (this.matches && this.evidence) {
        const verified = await verifyGameResult(
          this.matches,
          {
            matchId: job.matchId,
            gameId: job.gameId,
            platform: job.platform,
            username: job.username,
          },
          this.evidence,
        );
        if (!verified.ok)
          return {
            status:
              verified.status === 409 || verified.status === 400
                ? 'review_required'
                : 'failed',
            reason: verified.error,
          };
        return verified.result === null
          ? { status: 'in_progress' }
          : {
              status: 'completed',
              result: verified.result,
              decisionId: verified.decisionId,
            };
      }
      let result;

      if (job.platform === 'lichess') {
        result = await fetchLichessResult(job.gameId);
      } else if (job.platform === 'chessdotcom') {
        if (!job.username) {
          return {
            status: 'failed',
            reason: 'Chess.com requires username; job missing username field',
          };
        }
        result = await fetchChessDotComResult(job.username, job.gameId);
      } else {
        return {
          status: 'failed',
          reason: `Unknown platform: ${job.platform}`,
        };
      }

      // Check if game is still in progress
      if (result.result === null) {
        logger.info(
          {
            match_id: job.matchId,
            game_id: job.gameId,
            platform: job.platform,
            status: result.status,
          },
          'game_still_in_progress',
        );

        return {
          status: 'in_progress',
        };
      }

      // Game completed
      logger.info(
        {
          match_id: job.matchId,
          game_id: job.gameId,
          platform: job.platform,
          result: result.result,
        },
        'game_completed',
      );

      return {
        status: 'completed',
        result: result.result,
      };
    } catch (err) {
      // Handle rate limit errors — return 'in_progress' to retry
      if (err instanceof RateLimitError) {
        logger.warn(
          {
            match_id: job.matchId,
            game_id: job.gameId,
            platform: job.platform,
          },
          'game_poll_rate_limited_will_retry',
        );

        return {
          status: 'in_progress',
          reason: 'Rate limited by API, will retry',
        };
      }

      // Handle specific error types
      if (err instanceof GameNotFoundError) {
        logger.error(
          {
            match_id: job.matchId,
            game_id: job.gameId,
            platform: job.platform,
          },
          'game_not_found',
        );

        return {
          status: 'failed',
          reason: `Game not found: ${err.message}`,
        };
      }

      // Generic API error
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          match_id: job.matchId,
          game_id: job.gameId,
          platform: job.platform,
          error: message,
        },
        'game_poll_api_error',
      );

      return {
        status: 'failed',
        reason: `API error: ${message}`,
      };
    }
  }
}

export default ChessPlatformPoller;
