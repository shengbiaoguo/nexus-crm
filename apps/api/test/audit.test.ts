import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service.js';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { ApiException } from '../src/http/api.exception.js';
import { StructuredLogger } from '../src/logging/structured-logger.service.js';

test('audit persistence failures fail closed with safe 503 and correlation-only alerts', async () => {
  const lines: string[] = [];
  const audit = new AuditService(new StructuredLogger((line) => lines.push(line)));
  const client = {
    commandAttempt: {
      create: () => {
        throw new Error('secret sql password');
      },
      updateMany: () => {
        throw new Error('secret sql password');
      },
    },
  } as unknown as PrismaClient;
  const requestId = randomUUID();
  const context = { systemActor: 'test:audit', entityType: 'test', entityId: '1', requestId };
  const unavailable = (error: unknown) =>
    error instanceof ApiException &&
    error.getStatus() === 503 &&
    error.code === 'AUDIT_UNAVAILABLE';
  let businessRan = false;
  await assert.rejects(async () => {
    await audit.startAttempt(client, {
      ...context,
      operationId: 'test',
      idempotencyScope: 'system:test:audit',
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    });
    businessRan = true;
  }, unavailable);
  assert.equal(businessRan, false);
  await assert.rejects(
    audit.recordFailureAfterRollback(client, randomUUID(), 'TEST_FAILED'),
    unavailable,
  );
  const tx = {
    auditLog: {
      create: () => {
        throw new Error('secret sql password');
      },
    },
  } as unknown as Prisma.TransactionClient;
  const transactionalClient = {
    $transaction: async (work: (value: Prisma.TransactionClient) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  await assert.rejects(
    audit.withTransaction(transactionalClient, (value) =>
      audit.recordSuccess(value, { ...context, action: 'test' }),
    ),
    unavailable,
  );
  assert.equal(lines.length, 3);
  assert.equal((JSON.parse(lines[0]!) as { requestId: string }).requestId, requestId);
  assert.doesNotMatch(lines.join('\n'), /secret|sql|password/);
  await assert.rejects(
    audit.recordSuccess({ $transaction: () => {} } as unknown as Prisma.TransactionClient, {
      ...context,
      action: 'test',
    }),
    /interactive transaction/,
  );
  await assert.rejects(
    audit.startAttempt(client, {
      ...context,
      actorId: '1',
      operationId: 'test',
      idempotencyScope: 'user:1',
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    }),
    /Invalid audit metadata/,
  );
});
