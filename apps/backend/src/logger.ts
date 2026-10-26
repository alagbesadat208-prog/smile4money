import { traceLogFields } from './tracing/trace-context.js';

/**
 * Simple JSON logger for structured logging.
 * Outputs JSON to stdout for easy parsing and forwarding to logging services.
 */

interface LogContext {
  [key: string]: any;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Resolve the minimum log level that should actually be emitted (#1722).
 *
 * Explicit `LOG_LEVEL` always wins. Otherwise defaults to `info` in
 * production (so DEBUG-level output — including the request-body logging in
 * `middleware/request-logging.ts`, which may contain fields considered
 * sensitive even after redaction — never reaches production logs by
 * accident) and `debug` everywhere else.
 */
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
      message,
      // #123 — trace_id/span_id of the active W3C trace context, so log
      // lines from a request, its queued work and its retries join up.
      ...traceLogFields(),
      ...context,
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
