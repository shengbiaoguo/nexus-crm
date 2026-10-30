import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { StructuredLogger } from '../logging/structured-logger.service.js';

export function requestIdMiddleware(logging: boolean, logger = new StructuredLogger()) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    response.setHeader('X-Request-Id', requestId);
    // Never log headers, query strings or request bodies.
    if (logging) {
      response.once('finish', () =>
        logger.event('info', 'http_request', {
          requestId,
          method: request.method,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        }),
      );
    }
    next();
  };
}
