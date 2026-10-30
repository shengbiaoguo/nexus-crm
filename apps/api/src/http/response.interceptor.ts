import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import type { PaginationMeta } from '@nexus/shared';
import { map } from 'rxjs';
import { serializeJson } from './serialize-json.js';
import { IdempotencyResult } from '../idempotency/idempotency.contract.js';

/** Explicit list result avoids interpreting ordinary domain objects as envelopes. */
export class ListResult<T> {
  constructor(
    readonly data: T[],
    readonly meta: PaginationMeta,
  ) {}
}

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((value: unknown) => {
        if (value instanceof IdempotencyResult) {
          response.status(value.httpStatus);
          if (value.replayed) response.setHeader('Idempotency-Replayed', 'true');
          value = value.body;
        }
        if (response.statusCode === 204 || response.statusCode === 304) return undefined;
        const requestId = String(response.getHeader('X-Request-Id'));
        return value instanceof ListResult
          ? serializeJson({ data: value.data, meta: value.meta, requestId })
          : { data: serializeJson(value === undefined ? null : value), requestId };
      }),
    );
  }
}
