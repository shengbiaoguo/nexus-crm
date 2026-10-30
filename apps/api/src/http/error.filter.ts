import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const code =
      status === 400
        ? 'VALIDATION_FAILED'
        : status === 404
          ? 'RESOURCE_NOT_FOUND'
          : 'INTERNAL_ERROR';
    if (status >= 500) {
      this.logger.error({
        event: 'request_failed',
        requestId: response.getHeader('X-Request-Id'),
        code,
      });
    }
    response.status(status).json({
      code,
      message:
        status >= 500
          ? 'Internal server error'
          : status === 404
            ? 'Resource not found'
            : 'Invalid request',
      requestId: response.getHeader('X-Request-Id'),
    });
  }
}
