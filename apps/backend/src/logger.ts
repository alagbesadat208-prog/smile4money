import { LOG_EVENTS } from './log-events.js';

const NUMERIC_FIELDS = new Set([
  'status',
  'duration_ms',
  'count',
  'store_count',
  'attempt',
  'attempts',
  'max_retries',
  'retry_delay_ms',
  'nextRetryDelayMs',
  'totalAttempts',
  'port',
  'value',
  'remaining',
  'cooldown',
  'failureCount',
  'durationMs',
]);
const ENUM_FIELDS: Record<string, readonly string[]> = {
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  platform: ['lichess', 'chessdotcom'],
  state: ['CLOSED', 'OPEN', 'HALF_OPEN'],
  store: ['sqlite', 'memory', 'mongodb'],
  sqlite_error_code: ['SQLITE_BUSY', 'SQLITE_LOCKED'],
  metric: ['oracle_dlq_depth'],
};

/** Unknown fields and all arbitrary strings/errors are masked at the sink. */
export function safeLogContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context)
      .filter(
        ([key]) =>
          NUMERIC_FIELDS.has(key) ||
          Object.prototype.hasOwnProperty.call(ENUM_FIELDS, key),
      )
      .map(([key, value]) => [
        key,
        NUMERIC_FIELDS.has(key) &&
        typeof value === 'number' &&
        Number.isFinite(value)
          ? value
          : typeof value === 'string' && ENUM_FIELDS[key]?.includes(value)
            ? value
            : '[REDACTED]',
      ]),
  );
}

/**
 * Simple JSON logger for structured logging.
 * Outputs JSON to stdout for easy parsing and forwarding to logging services.
 */

interface LogContext {
  [key: string]: any;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

class Logger {
  /** Exposed so callers can skip building an expensive log payload entirely when it won't be emitted. */
  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel()];
  }

  private log(level: LogLevel, context: LogContext, message: string): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: 'smile4money-backend',
      message: LOG_EVENTS.has(message) ? message : 'log_event',
      ...safeLogContext(context),
    };
    console.log(JSON.stringify(logEntry));
  }

  debug(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.log('debug', {}, context);
    } else {
      this.log('debug', context, message || '');
    }
  }

  info(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.log('info', {}, context);
    } else {
      this.log('info', context, message || '');
    }
  }

  warn(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.log('warn', {}, context);
    } else {
      this.log('warn', context, message || '');
    }
  }

  error(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.log('error', {}, context);
    } else {
      this.log('error', context, message || '');
    }
  }
}

export default new Logger();
