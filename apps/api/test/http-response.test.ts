import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller, Get, HttpCode, HttpException, Param, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiException } from '../src/http/api.exception.js';
import { ErrorFilter } from '../src/http/error.filter.js';
import { requestIdMiddleware } from '../src/http/request-id.middleware.js';
import { ListResult, ResponseInterceptor } from '../src/http/response.interceptor.js';

@Controller('responses')
class ResponseController {
  @Get()
  object() {
    return { id: 18446744073709551615n, at: new Date('2026-10-30T00:00:00Z') };
  }

  @Post()
  create() {
    return { id: '1' };
  }

  @Get('list')
  list() {
    return new ListResult([{ id: '1' }], { page: 1, pageSize: 20, total: 1, totalPages: 1 });
  }

  @Get('null')
  emptyValue() {
    return null;
  }

  @Post('empty')
  @HttpCode(204)
  empty() {
    return undefined;
  }

  @Get('http/:status')
  httpError(@Param('status') status: string) {
    throw new HttpException(
      { code: 'FORGED_CODE', message: 'secret sql password', details: 'secret' },
      Number(status),
    );
  }

  @Get('business')
  business() {
    throw new ApiException('VERSION_CONFLICT', 'Version has changed', { expected: 1 });
  }

  @Get('unavailable')
  unavailable() {
    throw new ApiException('AUDIT_UNAVAILABLE', 'Audit unavailable');
  }

  @Get('unexpected')
  unexpected() {
    throw new Error('secret sql password');
  }

  @Get('serialization')
  serialization() {
    return { invalid: Number.NaN };
  }
}

test('HTTP envelopes preserve statuses, business codes and server request IDs', async () => {
  const module = await Test.createTestingModule({ controllers: [ResponseController] }).compile();
  const app = module.createNestApplication<NestExpressApplication>({
    logger: false,
    bodyParser: false,
  });
  app.use(requestIdMiddleware(false));
  app.useBodyParser('json', { limit: '1kb' });
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  const ids = new Set<string>();
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const request = async (path: string, status: number, init?: RequestInit) => {
      const response = await fetch(`${origin}${path}`, {
        ...init,
        headers: { 'X-Request-Id': 'forged-client-id', ...init?.headers },
      });
      assert.equal(response.status, status);
      const requestId = response.headers.get('x-request-id');
      assert.ok(requestId);
      assert.match(requestId, /^[a-f0-9-]{36}$/);
      assert.ok(!ids.has(requestId));
      ids.add(requestId);
      if (status === 204) {
        assert.equal(await response.text(), '');
        return null;
      }
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.requestId, requestId);
      return body;
    };
    const success = await request('/responses', 200);
    assert.deepEqual(success?.data, { id: '18446744073709551615', at: '2026-10-30T00:00:00.000Z' });
    assert.equal(success?.meta, undefined);
    assert.deepEqual((await request('/responses', 201, { method: 'POST' }))?.data, { id: '1' });
    const list = await request('/responses/list', 200);
    assert.deepEqual(list?.data, [{ id: '1' }]);
    assert.deepEqual(list?.meta, { page: 1, pageSize: 20, total: 1, totalPages: 1 });
    assert.equal((await request('/responses/null', 200))?.data, null);
    await request('/responses/empty', 204, { method: 'POST' });
    for (const [status, code] of [
      [400, 'VALIDATION_FAILED'],
      [401, 'UNAUTHENTICATED'],
      [403, 'PERMISSION_DENIED'],
      [404, 'RESOURCE_NOT_FOUND'],
      [409, 'BUSINESS_RULE_VIOLATION'],
      [422, 'VALIDATION_FAILED'],
      [429, 'RATE_LIMITED'],
      [500, 'INTERNAL_ERROR'],
      [503, 'SERVICE_UNAVAILABLE'],
      [413, 'HTTP_ERROR'],
    ] as const) {
      const error = await request(`/responses/http/${status}`, status);
      assert.equal(error?.code, code);
      assert.equal(error?.data, undefined);
      assert.equal(error?.details, undefined);
      assert.doesNotMatch(JSON.stringify(error), /secret|password|sql|FORGED_CODE|stack/);
    }
    const business = await request('/responses/business', 409);
    assert.equal(business?.code, 'VERSION_CONFLICT');
    assert.equal(business?.message, 'Version has changed');
    assert.deepEqual(business?.details, { expected: 1 });
    assert.equal((await request('/responses/unavailable', 503))?.code, 'AUDIT_UNAVAILABLE');
    for (const path of ['/responses/unexpected', '/responses/serialization']) {
      const error = await request(path, 500);
      assert.equal(error?.code, 'INTERNAL_ERROR');
      assert.equal(error?.message, 'Internal server error');
      assert.doesNotMatch(JSON.stringify(error), /secret|password|sql|stack/);
    }
    assert.equal((await request('/missing', 404))?.code, 'RESOURCE_NOT_FOUND');
    assert.equal(
      (
        await request('/responses', 400, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      )?.code,
      'VALIDATION_FAILED',
    );
    assert.equal(
      (
        await request('/responses', 413, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 'x'.repeat(2048) }),
        })
      )?.code,
      'HTTP_ERROR',
    );
  } finally {
    await app.close();
  }
});
