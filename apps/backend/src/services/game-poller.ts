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
import { fetchChessDotComResult, RateLimitError } from '../fetchers/chessdotcom.js';
import type { GamePoller, PollJob, PollJobStatus } from './polling.js';
import logger from '../logger.js';
import { ProviderFetchError } from '../fetchers/provider-validation.js';

/**
 * Create a game poller that fetches results from chess platform APIs.
 *
 * Handles:
 * - GameNotFoundError → stop polling
 * - Transient provider failures → retry within the worker attempt budget
 * - Invalid evidence/access failures → immediate operator review
 * - Rate limits → retry on a later polling cycle
 * - Game in progress (result === null) → 'in_progress' status
 * - Game completed (result !== null) → 'completed' status with result
 */
export class ChessPlatformPoller implements GamePoller {
  /**
   * Poll a single game and return its status.
   *
   * @returns PollJobStatus with status='in_progress', 'completed', or 'failed'
   */
  async poll(job: PollJob): Promise<PollJobStatus> {
    try {
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
      if (err instanceof ProviderFetchError) {
        return { status: 'failed', action: err.policy, reason: err.message };
      }
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
          action: 'stop',
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
