import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller, Post, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StructuredLogger } from '../src/logging/structured-logger.service.js';
import { requestIdMiddleware } from '../src/http/request-id.middleware.js';
import { ErrorFilter } from '../src/http/error.filter.js';

@Controller('log-fixture')
class LoggingController {
  @Post()
  fail(): never {
    throw new UnauthorizedException('secret-exception-text');
  }
}

test('HTTP completion and rejected request logs share the response request ID and omit sensitive input', async () => {
  const lines: string[] = [];
  const logger = new StructuredLogger((line) => lines.push(line));
  const module = await Test.createTestingModule({ controllers: [LoggingController] }).compile();
  const app = module.createNestApplication({ logger: false });
  app.use(requestIdMiddleware(true, logger));
  app.useGlobalFilters(new ErrorFilter(logger));
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/log-fixture?token=secret-query`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-header',
        Cookie: 'session=secret-cookie',
        'X-Request-Id': 'secret-client-id',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: 'secret-password', phone: '13800138000' }),
    });
    const body = (await response.json()) as { code: string; requestId: string };
    assert.equal(response.status, 401);
    assert.equal(body.code, 'UNAUTHENTICATED');
    const logs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(logs.length, 2);
    assert.ok(logs.some((log) => log.event === 'request_failed' && log.code === 'UNAUTHENTICATED'));
    assert.ok(logs.some((log) => log.event === 'http_request' && log.status === 401));
    assert.ok(logs.every((log) => log.requestId === body.requestId));
    assert.equal(body.requestId, response.headers.get('x-request-id'));
    assert.doesNotMatch(lines.join('\n'), /secret|13800138000|password|cookie|Bearer|log-fixture/);
  } finally {
    await app.close();
  }
});
