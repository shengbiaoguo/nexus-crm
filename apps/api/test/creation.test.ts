import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { creationResultId, prepareCommand } from '../src/idempotency/idempotency.contract.js';
import { IdempotencyService } from '../src/idempotency/idempotency.service.js';
import type { IdempotentCommand } from '../src/idempotency/idempotency.service.js';
import { IdempotencyStore } from '../src/idempotency/idempotency.store.js';
import { PrismaService } from '../src/infrastructure/prisma.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { StructuredLogger } from '../src/logging/structured-logger.service.js';

test('T03 creation summaries require 201 and canonical string IDs, preserving the full unsigned BIGINT range', () => {
  for (const id of ['1', '9007199254740993', '18446744073709551615'])
    assert.equal(creationResultId(201, { id }), id);
  for (const id of [
    null,
    1,
    true,
    '',
    '0',
    '01',
    '-1',
    '+1',
    '1.0',
    '1e3',
    ' 1',
    '1 ',
    '18446744073709551616',
  ])
    assert.throws(() => creationResultId(201, { id }), TypeError);
  for (const status of [200, 202, 204])
    assert.throws(() => creationResultId(status, { id: '1' }), TypeError);
  assert.throws(() => creationResultId(201, null), TypeError);
  assert.throws(() => creationResultId(201, {}), TypeError);
});

test('T03 new targets and creation mode must be declared together before any database or callback access', async () => {
  const database = new PrismaService('unused');
  Object.defineProperty(database, 'client', {
    get: () => {
      throw new Error('Unexpected database access');
    },
  });
  const service = new IdempotencyService(
    database,
    new AuditService(new StructuredLogger(() => {})),
    new IdempotencyStore(),
    () => {
      throw new Error('Unexpected recovery');
    },
  );
  const input: IdempotentCommand = {
    identity: { sub: '1', sid: '1', cv: 1 },
    key: randomUUID(),
    requestId: randomUUID(),
    operationId: 'test.create',
    entityType: 'contact',
    entityId: 'new',
    targets: { customerId: '7' },
    dto: {},
    responseFields: ['id'],
    authorize: async () => {
      throw new Error('Unexpected authorization');
    },
    execute: async () => {
      throw new Error('Unexpected execution');
    },
  };
  for (const invalid of [
    input,
    { ...input, createsEntity: false },
    { ...input, createsEntity: true, entityId: '7' },
  ])
    await assert.rejects(service.execute(invalid), /explicit creation adapter/);
});

test('T03 creation fingerprints use the stable new target and parent, independent of generated IDs, Key and request ID', () => {
  const input = {
    actorId: '1',
    key: randomUUID(),
    requestId: randomUUID(),
    operationId: 'test.createContact',
    entityType: 'contact',
    entityId: 'new',
    targets: { customerId: '7' },
    dto: { name: 'fixture' },
  };
  const first = prepareCommand(input);
  assert.equal(first.fingerprintVersion, 1);
  assert.equal(
    first.requestHash,
    prepareCommand({ ...input, key: randomUUID(), requestId: randomUUID() }).requestHash,
  );
  assert.notEqual(
    first.requestHash,
    prepareCommand({ ...input, targets: { customerId: '8' } }).requestHash,
  );
  assert.notEqual(
    first.requestHash,
    prepareCommand({ ...input, dto: { name: 'changed' } }).requestHash,
  );
});
