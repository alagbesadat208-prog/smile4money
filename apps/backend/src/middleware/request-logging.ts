import type { NextFunction, Request, Response } from 'express';
import logger from '../logger.js';

/** Log operational request metadata only, at every log level. */
export function requestLogging() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.info(
        {
          method: req.method,
          status: res.statusCode,
          duration_ms: Date.now() - startedAt,
        },
        'http_request',
      );
    });
    next();
  };
}

export default requestLogging;
