import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApplication } from '../../src/application.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { localDatabaseUrl } from '../../src/database/local-database.js';
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js';
import { PrismaService } from '../../src/infrastructure/prisma.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { AttemptReconciliationService } from '../../src/audit/attempt-reconciliation.service.js';
import { IdempotencyStore } from '../../src/idempotency/idempotency.store.js';
import { SalesWriteService } from '../../src/authorization/sales-write.service.js';
import { IdempotencyService } from '../../src/idempotency/idempotency.service.js';
import type { IdempotentCommand } from '../../src/idempotency/idempotency.service.js';
import { prepareCommand } from '../../src/idempotency/idempotency.contract.js';
import { newRefreshToken, refreshHash } from '../../src/auth/auth.crypto.js';
import type { AccessIdentity } from '../../src/auth/auth.crypto.js';
import { ApiException } from '../../src/http/api.exception.js';

const code = (value: string) => (error: unknown) =>
  error instanceof ApiException && error.code === value;
type Client = ReturnType<typeof createPrismaClient>;
type App = Awaited<ReturnType<typeof createApplication>>['app'];
interface Context {
  client: Client;
  app: App;
  audit: AuditService;
  service: IdempotencyService;
  identity: AccessIdentity;
  users: bigint[];
  customers: bigint[];
  roleId: bigint;
  command: (key?: string, parent?: number, name?: string) => Promise<IdempotentCommand>;
}

async function fixture(work: (context: Context) => Promise<void>) {
  const client = createPrismaClient(localDatabaseUrl());
  const { app } = await createApplication(
    { ...loadEnvironment(), AUTH_JWT_SECRET: randomBytes(32).toString('base64url') },
    false,
  );
  const users: bigint[] = [],
    customers: bigint[] = [];
  let roleId: bigint | undefined;
  try {
    for (let index = 0; index < 2; index++)
      users.push(
        (
          await client.user.create({
            data: {
              loginName: `t03-${randomUUID()}`,
              name: 'T03 fixture',
              passwordHash: 'no-login',
            },
          })
        ).id,
      );
    const session = await client.refreshSession.create({
      data: {
        userId: users[0]!,
        tokenHash: refreshHash(newRefreshToken()),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    const identity = { sub: String(users[0]), sid: String(session.id), cv: 1 };
    const permission = await client.permission.findUniqueOrThrow({
      where: { code: 'customer:update' },
    });
    roleId = (
      await client.role.create({ data: { code: `t03-${randomUUID()}`, name: 'T03 fixture' } })
    ).id;
    await client.rolePermission.create({
      data: { roleId, permissionId: permission.id, scopeCode: 'SELF_COLLABORATOR' },
    });
    await client.userRole.create({ data: { userId: users[0]!, roleId } });
    for (let index = 0; index < 2; index++)
      customers.push(
        (
          await client.customer.create({
            data: {
              name: `t03-${randomUUID()}`,
              normalizedName: 'T03',
              ownerId: users[0]!,
              createdBy: users[0]!,
            },
          })
        ).id,
      );
    await app.init();
    const writes = app.get(SalesWriteService),
      service = app.get(IdempotencyService),
      audit = app.get(AuditService);
    const command: Context['command'] = async (
      key = randomUUID(),
      parent = 0,
      name = 'T03 created contact',
    ) => {
      const target = { kind: 'customer' as const, id: customers[parent]! };
      const plan = await writes.plan(identity, 'customer:update', [target]);
      return {
        createsEntity: true,
        identity,
        key,
        requestId: randomUUID(),
        operationId: 'test.createContact',
        entityType: 'contact',
        entityId: 'new',
        targets: { customerId: String(target.id) },
        dto: { name },
        responseFields: ['id', 'version'],
        userLocks: plan.identity.users,
        authorize: (tx, phase) =>
          phase === 'preflight'
            ? writes.requireTargets(tx, identity, 'customer:update', [target])
            : writes.acquire(tx, identity, plan).then(() => undefined),
        execute: async (tx, dto) => {
          const contact = await tx.customerContact.create({
            data: {
              customerId: target.id,
              createdBy: users[0]!,
              name: (dto as { name: string }).name,
              phone: '123456',
            },
          });
          return { httpStatus: 201, body: { id: String(contact.id), version: contact.version } };
        },
      };
    };
    await work({ client, app, audit, service, identity, users, customers, roleId, command });
  } finally {
    try {
      await app.close();
    } finally {
      try {
        await client.auditLog.deleteMany({ where: { actorId: { in: users } } });
        await client.commandAttempt.deleteMany({ where: { actorId: { in: users } } });
        await client.idempotencyRecord.deleteMany({
          where: { scope: { in: users.map((id) => `user:${id}`) } },
        });
        await client.customerContact.deleteMany({ where: { customerId: { in: customers } } });
        await client.customer.deleteMany({ where: { id: { in: customers } } });
        await client.refreshSession.deleteMany({ where: { userId: { in: users } } });
        await client.userRole.deleteMany({ where: { userId: { in: users } } });
        if (roleId !== undefined) {
          await client.rolePermission.deleteMany({ where: { roleId } });
          await client.role.delete({ where: { id: roleId } });
        }
        await client.user.deleteMany({ where: { id: { in: users } } });
      } finally {
        await client.$disconnect();
      }
    }
  }
}

test('T03 real creation: concurrent same Key inserts once with stable fingerprint, real audit ID and linked resultRef; changed DTO/parent conflict', async () => {
  await fixture(async ({ client, service, command, users, customers }) => {
    const key = randomUUID();
    const first = await command(key),
      second = await command(key);
    const expected = prepareCommand({ ...first, actorId: first.identity.sub });
    const result = await Promise.all([service.execute(first), service.execute(second)]);
    assert.deepEqual(result.map(({ replayed }) => replayed).sort(), [false, true]);
    assert.deepEqual(result[0]!.body, result[1]!.body);
    const id = String(result[0]!.body!.id);
    const row = await client.customerContact.findUniqueOrThrow({ where: { id: BigInt(id) } });
    assert.equal(row.customerId, customers[0]);
    const attempts = await client.commandAttempt.findMany({
      where: { actorId: users[0]!, idempotencyKey: key },
    });
    assert.deepEqual(attempts.map(({ status }) => status).sort(), ['REPLAYED', 'SUCCEEDED']);
    assert.ok(
      attempts.every(
        (attempt) =>
          attempt.entityId === 'new' &&
          attempt.requestHash === expected.requestHash &&
          attempt.resultRef === `contact:${id}`,
      ),
    );
    const audit = await client.auditLog.findMany({
      where: { actorId: users[0]!, action: first.operationId },
    });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.entityId, id);
    const original = attempts.find(({ status }) => status === 'SUCCEEDED')!;
    assert.equal(audit[0]!.attemptId, original.attemptId);
    assert.equal(audit[0]!.requestId, original.requestId);
    const stored = await client.idempotencyRecord.findUniqueOrThrow({
      where: { scope_key: { scope: `user:${users[0]}`, key } },
    });
    assert.equal(stored.httpStatus, 201);
    assert.equal(stored.requestHash, expected.requestHash);
    assert.deepEqual(stored.responseBody, result[0]!.body);
    await assert.rejects(
      service.execute(await command(key, 0, 'changed')),
      code('IDEMPOTENCY_KEY_REUSED'),
    );
    await assert.rejects(service.execute(await command(key, 1)), code('IDEMPOTENCY_KEY_REUSED'));
    assert.equal(
      await client.customerContact.count({ where: { customerId: { in: customers } } }),
      1,
    );
  });
});

test('T03 real creation: missing/invalid IDs and non-201 results roll back inserts, audit and Key; same Key can explicitly retry', async () => {
  await fixture(async ({ client, service, command, users, customers }) => {
    for (const invalid of [
      { httpStatus: 201, body: {} },
      { httpStatus: 201, body: { id: '0' } },
      { httpStatus: 201, body: { id: 1 } },
      { httpStatus: 200, body: { id: '1' } },
    ]) {
      const input = await command();
      const execute = input.execute;
      await assert.rejects(
        service.execute({
          ...input,
          execute: async (tx, dto) => {
            await execute(tx, dto);
            return invalid;
          },
        }),
        code('SERVICE_UNAVAILABLE'),
      );
      assert.equal(
        await client.customerContact.count({ where: { customerId: { in: customers } } }),
        0,
      );
      assert.equal(
        await client.idempotencyRecord.count({
          where: { scope: `user:${users[0]}`, key: String(input.key) },
        }),
        0,
      );
    }
    assert.equal(await client.auditLog.count({ where: { actorId: users[0]! } }), 0);
    const input = await command();
    const original = input.execute;
    await assert.rejects(
      service.execute({
        ...input,
        execute: async (tx, dto) => {
          await original(tx, dto);
          throw new ApiException('BUSINESS_RULE_VIOLATION', 'fixture');
        },
      }),
      code('BUSINESS_RULE_VIOLATION'),
    );
    assert.equal((await service.execute(await command(String(input.key)))).httpStatus, 201);
    assert.equal(
      await client.customerContact.count({ where: { customerId: { in: customers } } }),
      1,
    );
  });
});

test('T03 real creation: replay rechecks current action, customer scope and credentials after success', async () => {
  await fixture(async ({ client, service, command, roleId, users, customers, identity }) => {
    const input = await command();
    const result = await service.execute(input);
    await client.rolePermission.updateMany({ where: { roleId }, data: { scopeCode: 'IDENTITY' } });
    await assert.rejects(service.execute(input), code('PERMISSION_DENIED'));
    await client.rolePermission.updateMany({
      where: { roleId },
      data: { scopeCode: 'SELF_COLLABORATOR' },
    });
    await client.customer.update({ where: { id: customers[0]! }, data: { ownerId: users[1]! } });
    await assert.rejects(service.execute(input), code('RESOURCE_NOT_FOUND'));
    await client.customer.update({ where: { id: customers[0]! }, data: { ownerId: users[0]! } });
    await client.user.update({
      where: { id: BigInt(identity.sub) },
      data: { credentialVersion: { increment: 1 } },
    });
    await assert.rejects(service.execute(input), code('UNAUTHENTICATED'));
    assert.equal(
      await client.customerContact.count({ where: { customerId: { in: customers } } }),
      1,
    );
    assert.equal(
      (
        await client.customerContact.findUniqueOrThrow({
          where: { id: BigInt(String(result.body!.id)) },
        })
      ).customerId,
      customers[0],
    );
  });
});

test('T03 real creation: committed result survives lost acknowledgement, reauthorizes through a separate client and never inserts twice', async () => {
  await fixture(async ({ client, app, audit, service, command, users, customers }) => {
    const database = app.get(PrismaService);
    const original = audit.withTransaction.bind(audit);
    const input = await command();
    const execute = input.execute;
    let calls = 0,
      inject = true,
      separate = false;
    audit.withTransaction = async (db, work, options) => {
      if (db !== database.client) separate = true;
      const result = await original(db, work, options);
      if (db === database.client && inject) {
        inject = false;
        throw new Error('Lost commit acknowledgement fixture');
      }
      return result;
    };
    try {
      const result = await service.execute({
        ...input,
        execute: (tx, dto) => {
          calls++;
          return execute(tx, dto);
        },
      });
      assert.equal(result.replayed, true);
      assert.equal(calls, 1);
      assert.equal(separate, true);
      assert.equal(
        await client.customerContact.count({ where: { customerId: { in: customers } } }),
        1,
      );
      const attempt = await client.commandAttempt.findFirstOrThrow({
        where: { actorId: users[0]!, idempotencyKey: String(input.key) },
      });
      assert.equal(attempt.status, 'SUCCEEDED');
      assert.equal(attempt.resultRef, `contact:${String(result.body!.id)}`);
      assert.equal(
        (await client.auditLog.findFirstOrThrow({ where: { attemptId: attempt.attemptId } }))
          .entityId,
        result.body!.id,
      );
    } finally {
      audit.withTransaction = original;
    }
  });
});

test('T03 real creation: malformed committed creation status is rejected even when recovery sees an already-SUCCEEDED attempt', async () => {
  await fixture(async ({ client, app, audit, service, command, users, customers }) => {
    const database = app.get(PrismaService);
    const original = audit.withTransaction.bind(audit);
    const input = await command();
    const execute = input.execute;
    let calls = 0,
      inject = true;
    audit.withTransaction = async (db, work, options) => {
      const result = await original(db, work, options);
      if (db === database.client && inject) {
        inject = false;
        await client.idempotencyRecord.update({
          where: { scope_key: { scope: `user:${users[0]}`, key: String(input.key) } },
          data: { httpStatus: 200 },
        });
        throw new Error('Malformed stored result and lost acknowledgement fixture');
      }
      return result;
    };
    try {
      await assert.rejects(
        service.execute({
          ...input,
          execute: (tx, dto) => {
            calls++;
            return execute(tx, dto);
          },
        }),
        code('IDEMPOTENCY_RESULT_UNKNOWN'),
      );
      assert.equal(calls, 1);
      assert.equal(
        await client.customerContact.count({ where: { customerId: { in: customers } } }),
        1,
      );
      const attempt = await client.commandAttempt.findFirstOrThrow({
        where: { actorId: users[0]!, idempotencyKey: String(input.key) },
      });
      assert.equal(attempt.status, 'SUCCEEDED');
      assert.equal(await client.auditLog.count({ where: { attemptId: attempt.attemptId } }), 1);
    } finally {
      audit.withTransaction = original;
    }
  });
});

test('T03 real creation: malformed completed creation snapshots cannot be replayed or trigger another insert', async () => {
  await fixture(async ({ client, service, command, users, customers }) => {
    const input = await command();
    const result = await service.execute(input);
    for (const data of [
      { httpStatus: 200 },
      { httpStatus: 201, responseBody: {} },
      { httpStatus: 201, responseBody: { id: '01' } },
    ]) {
      await client.idempotencyRecord.update({
        where: { scope_key: { scope: `user:${users[0]}`, key: String(input.key) } },
        data,
      });
      await assert.rejects(
        service.execute(await command(String(input.key))),
        code('IDEMPOTENCY_RESULT_UNKNOWN'),
      );
    }
    assert.equal(
      await client.customerContact.count({ where: { customerId: { in: customers } } }),
      1,
    );
    const attempt = await client.commandAttempt.findFirstOrThrow({
      where: { actorId: users[0]!, status: 'SUCCEEDED' },
    });
    assert.equal(attempt.resultRef, `contact:${String(result.body!.id)}`);
    assert.equal(await client.auditLog.count({ where: { actorId: users[0]! } }), 1);
  });
});

test('T03 real creation audit: actor/request/action/type/target/state and generated-ID correspondence remain enforced; swallowed errors cannot commit', async () => {
  await fixture(async ({ client, audit, users, customers }) => {
    const base = {
      actorId: String(users[0]),
      entityType: 'contact',
      entityId: 'new',
      requestId: randomUUID(),
      operationId: 'test.createContact',
      idempotencyScope: `user:${users[0]}`,
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    };
    for (const change of [
      { actorId: String(users[1]) },
      { requestId: randomUUID() },
      { action: 'test.other' },
      { entityType: 'other' },
      { entityId: String(customers[0]) },
      { resultRef: 'contact:01' },
    ]) {
      const attemptId = await audit.startAttempt(client, { ...base, idempotencyKey: randomUUID() });
      await assert.rejects(
        audit.withTransaction(
          client,
          async (tx) => {
            const row = await tx.customerContact.create({
              data: {
                customerId: customers[0]!,
                createdBy: users[0]!,
                name: 'must roll back',
                phone: '123456',
              },
            });
            try {
              await audit.recordSuccess(tx, {
                ...base,
                action: base.operationId,
                attemptId,
                createdEntityId: String(row.id),
                resultRef: `contact:${row.id}`,
                ...change,
                ...('entityType' in change ? { resultRef: `other:${row.id}` } : {}),
              });
            } catch {
              /* deliberately swallowed: transaction poisoning must still abort */
            }
          },
          { isolationLevel: 'ReadCommitted' },
        ),
        code('AUDIT_UNAVAILABLE'),
      );
      assert.equal(
        (await client.commandAttempt.findUniqueOrThrow({ where: { attemptId } })).status,
        'STARTED',
      );
      await audit.recordFailureAfterRollback(client, attemptId, 'BUSINESS_RULE_VIOLATION');
    }
    const attemptId = await audit.startAttempt(client, { ...base, idempotencyKey: randomUUID() });
    await audit.recordFailureAfterRollback(client, attemptId, 'BUSINESS_RULE_VIOLATION');
    await assert.rejects(
      audit.withTransaction(
        client,
        (tx) =>
          audit.recordSuccess(tx, {
            ...base,
            action: base.operationId,
            attemptId,
            createdEntityId: '1',
            resultRef: 'contact:1',
          }),
        { isolationLevel: 'ReadCommitted' },
      ),
      code('AUDIT_UNAVAILABLE'),
    );
    assert.equal(
      await client.customerContact.count({ where: { customerId: { in: customers } } }),
      0,
    );
    assert.equal(await client.auditLog.count({ where: { actorId: { in: users } } }), 0);
  });
});

test('T03 real creation evidence: reconciliation shares the 201/ID contract without executing business or broadening its batch', async () => {
  await fixture(async ({ client, service, command, users, customers }) => {
    const input = await command();
    await service.execute(input);
    const attempt = await client.commandAttempt.findFirstOrThrow({
      where: { actorId: users[0]!, idempotencyKey: String(input.key), status: 'SUCCEEDED' },
    });
    // Only this fixture's attempt/result are fault-injected; no historical rows or job scan.
    await client.commandAttempt.update({ where: { id: attempt.id }, data: { status: 'UNKNOWN' } });
    await client.idempotencyRecord.update({
      where: { scope_key: { scope: `user:${users[0]}`, key: String(input.key) } },
      data: { httpStatus: 200 },
    });
    const reconciliation = new AttemptReconciliationService(new IdempotencyStore());
    const unknown = await reconciliation.runBatch(client, 0n, new Date(), [attempt.attemptId]);
    assert.equal(unknown.examined, 1);
    assert.equal(unknown.confirmed, 0);
    assert.equal(unknown.unknown, 1);
    assert.equal(
      (await client.commandAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      'UNKNOWN',
    );
    await client.idempotencyRecord.update({
      where: { scope_key: { scope: `user:${users[0]}`, key: String(input.key) } },
      data: { httpStatus: 201 },
    });
    const confirmed = await reconciliation.runBatch(client, 0n, new Date(), [attempt.attemptId]);
    assert.equal(confirmed.examined, 1);
    assert.equal(confirmed.confirmed, 1);
    assert.equal(
      (await client.commandAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      'SUCCEEDED',
    );
    assert.equal(
      await client.customerContact.count({ where: { customerId: { in: customers } } }),
      1,
    );
    assert.equal(await client.auditLog.count({ where: { actorId: users[0]! } }), 1);
  });
});
