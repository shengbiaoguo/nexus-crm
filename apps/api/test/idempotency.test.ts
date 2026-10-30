import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  canonicalJson,
  prepareCommand,
  responseSnapshot,
  IdempotencyResult,
  inProgress,
  userLockPlan,
} from '../src/idempotency/idempotency.contract.js';
import { ErrorFilter } from '../src/http/error.filter.js';
import { ResponseInterceptor } from '../src/http/response.interceptor.js';
import { requestIdMiddleware } from '../src/http/request-id.middleware.js';

const metadata = () => ({
  actorId: '9007199254740993',
  key: randomUUID(),
  requestId: randomUUID(),
  operationId: 'test.command',
  entityType: 'user',
  entityId: '123',
  targets: { userId: '123' },
  dto: { expectedVersion: 1 },
});

test('fingerprint v1 sorts object keys, preserves arrays/null/defaults and separates actor Key scope from request semantics', () => {
  const input = metadata();
  const original = prepareCommand(input);
  assert.equal(
    original.requestHash,
    '175efd7af6e997b19d5a706dac1dd836a6704c55667b7e9c63c04d29c7eab348',
  );
  assert.equal(original.key, String(input.key).toLowerCase());
  assert.equal(original.scope, 'user:9007199254740993');
  assert.equal(
    original.requestHash,
    prepareCommand({ ...input, key: randomUUID(), requestId: randomUUID() }).requestHash,
  );
  assert.equal(original.requestHash, prepareCommand({ ...input, actorId: '1' }).requestHash);
  for (const changed of [
    { operationId: 'test.reject' },
    { entityId: '124' },
    { targets: { userId: '124' } },
    { dto: { expectedVersion: 2 } },
  ])
    assert.notEqual(original.requestHash, prepareCommand({ ...input, ...changed }).requestHash);
  assert.equal(
    canonicalJson({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
  );
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.notEqual(canonicalJson({}), canonicalJson({ note: null }));
  assert.equal(prepareCommand({ ...input, key: String(input.key).toUpperCase() }).key, input.key);
  assert.throws(() => prepareCommand({ ...input, key: ['one', 'two'] }));
  assert.throws(() => prepareCommand({ ...input, key: 'not-a-uuid' }));
  assert.throws(() => prepareCommand({ ...input, actorId: '18446744073709551616' }));
});

test('canonical input rejects implicit BigInt/date conversions, unsafe numbers, sparse arrays and unsupported data', () => {
  const sparse = [0, 1];
  Reflect.deleteProperty(sparse, '0');
  for (const value of [
    undefined,
    1n,
    new Date(),
    NaN,
    Infinity,
    9007199254740992,
    sparse,
    { note: undefined },
    new Map(),
  ])
    assert.throws(() => canonicalJson(value));
  assert.throws(() =>
    canonicalJson({
      get x() {
        return 'untrusted';
      },
    }),
  );
  assert.equal(
    canonicalJson({ amount: '12.30', id: '9007199254740993', at: '2026-10-30T00:00:00.000Z' }),
    '{"amount":"12.30","at":"2026-10-30T00:00:00.000Z","id":"9007199254740993"}',
  );
});

test('result snapshots require explicit scalar fields, reject credentials and enforce UTF-8 64 KiB before commit', () => {
  assert.deepEqual(
    responseSnapshot({ id: '1', version: 2, password: 'never-store' }, ['id', 'version'], 201),
    { id: '1', version: 2 },
  );
  assert.throws(() => responseSnapshot({ token: 'private' }, ['token'], 200));
  assert.throws(() => responseSnapshot({ id: { token: 'private' } }, ['id'], 200));
  assert.throws(() => responseSnapshot({ status: '中'.repeat(22000) }, ['status'], 200), /64 KiB/);
  assert.throws(() => responseSnapshot({}, [], 200));
  assert.throws(() => responseSnapshot({}, ['id'], 400));
  assert.equal(responseSnapshot(null, [], 204), null);
});

test('related-user locks include the actor, sort numeric IDs and retain the strongest duplicate lock mode', () => {
  assert.deepEqual(
    userLockPlan('10', [
      { id: '2', mode: 'UPDATE' },
      { id: '2', mode: 'SHARE' },
      { id: '10', mode: 'UPDATE' },
    ]),
    [
      { id: '2', mode: 'UPDATE' },
      { id: '10', mode: 'UPDATE' },
    ],
  );
  assert.throws(() => userLockPlan('10', [{ id: '01', mode: 'SHARE' }]));
});

@Controller('idempotency-probe')
class ProbeController {
  @Get('first') first() {
    return new IdempotencyResult(201, { id: '1' }, false);
  }
  @Get('replay') replay() {
    return new IdempotencyResult(201, { id: '1' }, true);
  }
  @Get('empty') empty() {
    return new IdempotencyResult(204, null, true);
  }
  @Get('pending') pending() {
    throw inProgress();
  }
}

test('HTTP adapter preserves first status/snapshot, renews request ID, marks replay and sends Retry-After', async () => {
  const module = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
  const app = module.createNestApplication({ logger: false });
  app.use(requestIdMiddleware(false));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new ErrorFilter());
  try {
    await app.listen(0, '127.0.0.1');
    const origin = `${await app.getUrl()}/idempotency-probe`;
    const first = await fetch(`${origin}/first`);
    const replay = await fetch(`${origin}/replay`);
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal(first.headers.get('idempotency-replayed'), null);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    const body1 = (await first.json()) as { data: unknown; requestId: string };
    const body2 = (await replay.json()) as { data: unknown; requestId: string };
    assert.deepEqual(body1.data, body2.data);
    assert.notEqual(body1.requestId, body2.requestId);
    const empty = await fetch(`${origin}/empty`);
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), '');
    const pending = await fetch(`${origin}/pending`);
    assert.equal(pending.status, 409);
    assert.equal(pending.headers.get('retry-after'), '1');
  } finally {
    await app.close();
  }
});
