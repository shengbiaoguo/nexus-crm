import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { DtoValidationException } from './validation.pipe.js';
import { ApiException } from './api.exception.js';
import { serializeJson } from './serialize-json.js';
import { StructuredLogger } from '../logging/structured-logger.service.js';

const httpErrors: Record<number, { code: string; message: string }> = {
  400: { code: 'VALIDATION_FAILED', message: 'Invalid request' },
  401: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
  403: { code: 'PERMISSION_DENIED', message: 'Permission denied' },
  404: { code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' },
  409: { code: 'BUSINESS_RULE_VIOLATION', message: 'Business rule violation' },
  422: { code: 'VALIDATION_FAILED', message: 'Invalid request' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests' },
  503: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' },
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger = new StructuredLogger()) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const fallback =
      httpErrors[status] ??
      (status >= 500
        ? { code: 'INTERNAL_ERROR', message: 'Internal server error' }
        : { code: 'HTTP_ERROR', message: 'Request failed' });
    const code = exception instanceof ApiException ? exception.code : fallback.code;
    if (code === 'IDEMPOTENCY_IN_PROGRESS') response.setHeader('Retry-After', '1');
    const message = exception instanceof ApiException ? exception.publicMessage : fallback.message;
    if (status >= 400) {
      this.logger.event(status >= 500 ? 'error' : 'warn', 'request_failed', {
        requestId: String(response.getHeader('X-Request-Id')),
        status,
        code,
      });
    }
    response.status(status).json({
      code,
      ...(exception instanceof DtoValidationException
        ? { details: { fields: exception.fields } }
        : exception instanceof ApiException && exception.details !== undefined
          ? { details: serializeJson(exception.details) }
          : {}),
      message,
      requestId: response.getHeader('X-Request-Id'),
    });
  }
}
