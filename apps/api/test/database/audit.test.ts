import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../src/audit/audit.service.js';
import type { AttemptInput } from '../../src/audit/audit.service.js';
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js';
import { localDatabaseUrl } from '../../src/database/local-database.js';
import { StructuredLogger } from '../../src/logging/structured-logger.service.js';
import { ApiException } from '../../src/http/api.exception.js';

const client = createPrismaClient(localDatabaseUrl());
const audit = new AuditService(new StructuredLogger(() => {}));
after(async () => {
  await client.$disconnect();
});

async function fixture(work: (input: AttemptInput) => Promise<void>) {
  const user = await client.user.create({
    data: {
      loginName: `audit-test-${randomUUID()}`,
      passwordHash: 'test-only-placeholder',
      name: 'audit fixture',
    },
  });
  const scope = `user:${user.id}`;
  const input: AttemptInput = {
    actorId: user.id.toString(),
    entityType: 'user',
    entityId: user.id.toString(),
    requestId: randomUUID(),
    operationId: 'test.audit',
    idempotencyScope: scope,
    idempotencyKey: randomUUID(),
    requestHash: 'a'.repeat(64),
  };
  try {
    await work(input);
  } finally {
    // Remove only this test's own generated fixture, in FK order. Never purge real audit history.
    await client.auditLog.deleteMany({ where: { actorId: user.id } });
    await client.commandAttempt.deleteMany({ where: { actorId: user.id } });
    await client.idempotencyRecord.deleteMany({ where: { scope } });
    await client.user.delete({ where: { id: user.id } });
  }
}

test('real MySQL: committed audit links actor, object, request, attempt and idempotency result, with redacted snapshots', async () => {
  await fixture(async (input) => {
    const attemptId = await audit.startAttempt(client, input);
    const id = await audit.withTransaction(client, async (tx) => {
      await tx.user.update({ where: { id: BigInt(input.actorId!) }, data: { status: 'DISABLED' } });
      await tx.idempotencyRecord.create({
        data: {
          scope: input.idempotencyScope,
          key: input.idempotencyKey,
          requestHash: input.requestHash,
          status: 'COMPLETED',
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
          httpStatus: 200,
          responseBody: { id: input.entityId, status: 'DISABLED' },
        },
      });
      return audit.recordSuccess(tx, {
        ...input,
        attemptId,
        action: 'test.audit',
        resultRef: `user:${input.entityId}`,
        before: { value: { status: 'ACTIVE' }, fields: ['status'] },
        after: {
          value: {
            status: 'DISABLED',
            passwordHash: 'never-store-password',
            phone: '13800138000',
            bankAccount: '6222021234567890123',
            unselected: 'never-store-hidden',
          },
          fields: ['status', 'passwordHash', 'phone', 'bankAccount'],
        },
      });
    });
    const stored = await client.auditLog.findUniqueOrThrow({
      where: { id: BigInt(id) },
      include: { actor: true, attempt: true },
    });
    assert.equal(stored.actor?.id.toString(), input.actorId);
    assert.equal(stored.actor?.status, 'DISABLED');
    assert.equal(stored.entityId, input.entityId);
    assert.equal(stored.entityType, input.entityType);
    assert.equal(stored.requestId, input.requestId);
    assert.equal(stored.attempt?.requestId, input.requestId);
    assert.equal(stored.attempt?.attemptId, attemptId);
    assert.equal(stored.attempt?.status, 'SUCCEEDED');
    assert.equal(stored.attempt?.operationId, input.operationId);
    assert.equal(stored.attempt?.resultRef, `user:${input.entityId}`);
    assert.ok(stored.attempt?.finishedAt);
    assert.ok(stored.createdAt instanceof Date);
    assert.deepEqual(stored.beforeJson, { status: 'ACTIVE' });
    assert.deepEqual(stored.afterJson, {
      status: 'DISABLED',
      passwordHash: '[REDACTED]',
      phone: '[REDACTED]',
      bankAccount: '[REDACTED]',
    });
    assert.equal(
      await client.idempotencyRecord.count({
        where: { scope: input.idempotencyScope, status: 'COMPLETED' },
      }),
      1,
    );
    // Replays use a new request/attempt, and do not create a second success audit.
    const replayInput = { ...input, requestId: randomUUID() };
    const replayId = await audit.startAttempt(client, replayInput);
    await audit.withTransaction(client, (tx) =>
      audit.recordReplay(tx, {
        ...replayInput,
        attemptId: replayId,
        resultRef: `user:${input.entityId}`,
      }),
    );
    assert.equal(
      (await client.commandAttempt.findUniqueOrThrow({ where: { attemptId: replayId } })).status,
      'REPLAYED',
    );
    assert.equal(await client.auditLog.count({ where: { actorId: BigInt(input.actorId!) } }), 1);
  });
});

test('real MySQL: rollback removes business/audit/idempotency success, independent attempt remains traceable', async () => {
  await fixture(async (input) => {
    const attemptId = await audit.startAttempt(client, input);
    const failure = new Error('test:confirmed-rollback');
    await assert.rejects(
      audit.withTransaction(client, async (tx) => {
        await tx.user.update({
          where: { id: BigInt(input.actorId!) },
          data: { status: 'DISABLED' },
        });
        await tx.idempotencyRecord.create({
          data: {
            scope: input.idempotencyScope,
            key: input.idempotencyKey,
            requestHash: input.requestHash,
            status: 'COMPLETED',
            expiresAt: new Date(Date.now() + 60000),
          },
        });
        await audit.recordSuccess(tx, { ...input, attemptId, action: 'test.audit' });
        throw failure;
      }),
      (error: unknown) => error === failure,
    );
    assert.equal(
      (await client.user.findUniqueOrThrow({ where: { id: BigInt(input.actorId!) } })).status,
      'ACTIVE',
    );
    assert.equal(await client.auditLog.count({ where: { attemptId } }), 0);
    assert.equal(
      await client.idempotencyRecord.count({ where: { scope: input.idempotencyScope } }),
      0,
    );
    assert.equal(
      (await client.commandAttempt.findUniqueOrThrow({ where: { attemptId } })).status,
      'STARTED',
    );
    await audit.recordFailureAfterRollback(client, attemptId, 'TEST_ROLLBACK');
    const failed = await client.commandAttempt.findUniqueOrThrow({ where: { attemptId } });
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.errorCode, 'TEST_ROLLBACK');
    assert.equal(failed.requestId, input.requestId);
    assert.ok(failed.finishedAt);
  });
});

test('real MySQL: mismatched context and duplicate success fail closed; recovery cannot overwrite committed success', async () => {
  await fixture(async (input) => {
    const attemptId = await audit.startAttempt(client, input);
    const unavailable = (error: unknown) =>
      error instanceof ApiException && error.code === 'AUDIT_UNAVAILABLE';
    await assert.rejects(
      audit.recordSuccess(client, { ...input, attemptId, action: 'test.audit' }),
      /withTransaction/,
    );
    await assert.rejects(
      audit.withTransaction(client, (tx) =>
        audit.recordSuccess(tx, {
          ...input,
          requestId: randomUUID(),
          attemptId,
          action: 'test.audit',
        }),
      ),
      unavailable,
    );
    assert.equal(await client.auditLog.count({ where: { attemptId } }), 0);
    await assert.rejects(
      audit.withTransaction(client, async (tx) => {
        await tx.user.update({
          where: { id: BigInt(input.actorId!) },
          data: { status: 'DISABLED' },
        });
        // Even if a future caller accidentally swallows audit failure, business changes must roll back.
        try {
          await audit.recordSuccess(tx, {
            ...input,
            requestId: randomUUID(),
            attemptId,
            action: 'test.audit',
          });
        } catch {
          /* Deliberate fault injection. */
        }
      }),
      unavailable,
    );
    assert.equal(
      (await client.user.findUniqueOrThrow({ where: { id: BigInt(input.actorId!) } })).status,
      'ACTIVE',
    );
    await client.commandAttempt.update({
      where: { attemptId },
      data: { startedAt: new Date(Date.now() - 600000) },
    });
    assert.equal(await audit.markOverdueUnknown(client, new Date(), [attemptId]), 1);
    const unknown = await client.commandAttempt.findUniqueOrThrow({ where: { attemptId } });
    assert.equal(unknown.status, 'UNKNOWN');
    assert.equal(unknown.finishedAt, null);
    // Hold the actual MySQL row lock while an independent unknown update competes.
    let prepared!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const success = audit.withTransaction(
      client,
      async (tx) => {
        await audit.recordSuccess(tx, { ...input, attemptId, action: 'test.audit' });
        prepared();
        await gate;
      },
      { timeout: 10000 },
    );
    // If preparing fails, reject rather than waiting forever for ready.
    await Promise.race([
      ready,
      success.then(() => {
        throw new Error('Missing prepared signal');
      }),
    ]);
    const recovery = audit.markUnknown(client, attemptId);
    release();
    await Promise.all([success, recovery]);
    await audit.markUnknown(client, attemptId);
    await assert.rejects(
      audit.recordFailureAfterRollback(client, attemptId, 'TEST_FAILED'),
      unavailable,
    );
    assert.equal(
      (await client.commandAttempt.findUniqueOrThrow({ where: { attemptId } })).status,
      'SUCCEEDED',
    );
    await assert.rejects(
      audit.withTransaction(client, (tx) =>
        audit.recordSuccess(tx, { ...input, attemptId, action: 'test.audit' }),
      ),
      unavailable,
    );
    assert.equal(await client.auditLog.count({ where: { attemptId } }), 1);
  });
});
