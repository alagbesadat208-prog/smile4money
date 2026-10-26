import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import logger from '../src/logger.js';

/**
 * Test suite for structured JSON logging.
 *
 * Verifies that:
 * 1. Logger outputs valid JSON with all required fields
 * 2. Context fields are properly included in the output
 * 3. All log levels (info, warn, error) work correctly
 * 4. Standard fields (timestamp, level, message, service) are present
 */
describe('Structured JSON Logger', () => {
  let logOutput: string[] = [];

  beforeEach(() => {
    logOutput = [];

    vi.spyOn(console, 'log').mockImplementation((value) => {
      logOutput.push(String(value) + '\n');
    });

    // Set to production mode for JSON output (not pretty-printing)
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NODE_ENV;
  });

  it('logger.info emits valid JSON with context and message', () => {
    const context = { count: 123, player: 'alice' };
    const message = 'http_request';

    logger.info(context, message);

    // Join output and parse JSON lines
    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());

    expect(lines.length).toBeGreaterThan(0);

    // Parse first line as JSON
    const json = JSON.parse(lines[0]);

    // Verify required fields
    expect(json).toHaveProperty('timestamp');
    expect(json).toHaveProperty('level', 'info');
    expect(json).toHaveProperty('message', message);
    expect(json).toHaveProperty('service', 'smile4money-backend');

    // Verify context fields are included
    expect(json).toHaveProperty('count', 123);
    expect(json).not.toHaveProperty('player');

    // Verify timestamp is ISO format
    const timestamp = new Date(json.timestamp);
    expect(timestamp instanceof Date && !isNaN(timestamp.getTime())).toBe(true);
  });

  it('logger.warn emits valid JSON with context and message', () => {
    const context = { dlqId: 'dlq-123', attempt: 2 };
    const message = 'retry_failed';

    logger.warn(context, message);

    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());
    const json = JSON.parse(lines[0]);

    expect(json.level).toBe('warn');
    expect(json.message).toBe('log_event');
    expect(json.dlqId).toBeUndefined();
    expect(json.attempt).toBe(2);
  });

  it('logger.error emits valid JSON with context and message', () => {
    const context = { tx_hash: 'abc123', error_code: 'SUBMISSION_FAILED' };
    const message = 'oracle_submission_error';

    logger.error(context, message);

    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());
    const json = JSON.parse(lines[0]);

    expect(json.level).toBe('error');
    expect(json.message).toBe('log_event');
    expect(json.tx_hash).toBeUndefined();
    expect(json.error_code).toBeUndefined();
  });

  it('logger handles empty context correctly', () => {
    logger.info({}, 'empty_context_test');

    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());
    const json = JSON.parse(lines[0]);

    expect(json.level).toBe('info');
    expect(json.message).toBe('log_event');
    expect(json.service).toBe('smile4money-backend');
  });

  it('logger handles complex context with nested objects', () => {
    const context = {
      match_id: 456,
      result: {
        winner: 'Player1',
        score: { white: 1, black: 0 },
      },
      timestamp_ms: Date.now(),
    };
    const message = 'complex_context_test';

    logger.info(context, message);

    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());
    const json = JSON.parse(lines[0]);

    expect(json.match_id).toBeUndefined();
    expect(json.result).toBeUndefined();
  });

  it('logger includes service field in all logs', () => {
    logger.info({ event: 'info_test' }, 'info_event');
    logger.warn({ event: 'warn_test' }, 'warn_event');
    logger.error({ event: 'error_test' }, 'error_event');

    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());

    const logs = lines.map((line) => JSON.parse(line));

    logs.forEach((log) => {
      expect(log.service).toBe('smile4money-backend');
      expect(log.timestamp).toBeDefined();
    });
  });

  // #1722 — log level gating, which request-logging.ts relies on to keep
  // DEBUG-only output (including request bodies) out of production logs.
  describe('log level gating', () => {
    afterEach(() => {
      delete process.env.LOG_LEVEL;
    });

    it('defaults to suppressing debug output in production (NODE_ENV=production, no LOG_LEVEL)', () => {
      // beforeEach already sets NODE_ENV=production.
      expect(logger.isLevelEnabled('debug')).toBe(false);
      expect(logger.isLevelEnabled('info')).toBe(true);

      logger.debug({ secret: 'should-not-appear' }, 'debug_event');
      expect(logOutput.join('')).toBe('');
    });

    it('defaults to allowing debug output outside production', () => {
      process.env.NODE_ENV = 'development';
      expect(logger.isLevelEnabled('debug')).toBe(true);

      logger.debug({ foo: 'bar' }, 'debug_event');
      expect(logOutput.join('')).not.toBe('');
    });

    it('LOG_LEVEL=debug overrides the production default', () => {
      process.env.LOG_LEVEL = 'debug';
      expect(logger.isLevelEnabled('debug')).toBe(true);

      logger.debug({ foo: 'bar' }, 'debug_event');
      expect(logOutput.join('')).not.toBe('');
    });

    it('LOG_LEVEL=error suppresses info and warn, not just debug', () => {
      process.env.LOG_LEVEL = 'error';
      expect(logger.isLevelEnabled('debug')).toBe(false);
      expect(logger.isLevelEnabled('info')).toBe(false);
      expect(logger.isLevelEnabled('warn')).toBe(false);
      expect(logger.isLevelEnabled('error')).toBe(true);

      logger.info({}, 'should_be_suppressed');
      logger.warn({}, 'should_be_suppressed');
      expect(logOutput.join('')).toBe('');

      logger.error({}, 'should_appear');
      expect(logOutput.join('')).not.toBe('');
    });

    it('an invalid LOG_LEVEL value falls back to the environment default rather than throwing', () => {
      process.env.LOG_LEVEL = 'not-a-real-level';
      expect(() => logger.info({}, 'still_works')).not.toThrow();
      expect(logger.isLevelEnabled('info')).toBe(true); // production default
    });
  });
});
