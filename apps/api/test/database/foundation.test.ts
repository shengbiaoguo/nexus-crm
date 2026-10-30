import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createApplication } from '../../src/application.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { localDatabaseUrl } from '../../src/database/local-database.js';
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js';
import { PrismaService } from '../../src/infrastructure/prisma.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { SalesAuthorizationService } from '../../src/authorization/sales-authorization.service.js';
import type { SalesRootResolver } from '../../src/authorization/sales-authorization.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { WriteLockService } from '../../src/authorization/write-lock.service.js';
import { IdempotencyService } from '../../src/idempotency/idempotency.service.js';
import { IdempotencyStore } from '../../src/idempotency/idempotency.store.js';
import { AttemptReconciliationService } from '../../src/audit/attempt-reconciliation.service.js';
import { BootstrapIdentityService } from '../../src/database/bootstrap-identity.service.js';
import { newRefreshToken, refreshHash, verifyPassword } from '../../src/auth/auth.crypto.js';
import { ApiException } from '../../src/http/api.exception.js';
import type { ScopeCode } from '../../src/generated/prisma/enums.js';
import type { Prisma } from '../../src/generated/prisma/client.js';

const code = (expected: string) => (error: unknown) =>
  error instanceof ApiException && error.code === expected;

async function fixture(
  work: (context: {
    client: ReturnType<typeof createPrismaClient>;
    app: Awaited<ReturnType<typeof createApplication>>['app'];
    users: bigint[];
    departments: bigint[];
    identity: { sub: string; sid: string; cv: number };
    grant: (permission: string, scope: ScopeCode) => Promise<bigint>;
    root: SalesRootResolver;
  }) => Promise<void>,
) {
  const client = createPrismaClient(localDatabaseUrl());
  const { app } = await createApplication(
    { ...loadEnvironment(), AUTH_JWT_SECRET: randomBytes(32).toString('base64url') },
    false,
  );
  const users: bigint[] = [];
  const roles: bigint[] = [];
  const permissions: bigint[] = [];
  const departments: bigint[] = [];
  try {
    const parent = await client.department.create({ data: { name: `foundation-${randomUUID()}` } });
    departments.push(parent.id);
    const child = await client.department.create({
      data: { name: `foundation-${randomUUID()}`, parentId: parent.id },
    });
    departments.push(child.id);
    const outside = await client.department.create({
      data: { name: `foundation-${randomUUID()}` },
    });
    departments.push(outside.id);
    for (const departmentId of [parent.id, child.id, outside.id]) {
      const user = await client.user.create({
        data: {
          loginName: `foundation-${randomUUID()}`,
          name: 'foundation fixture',
          passwordHash: 'no-login',
          departmentId,
        },
      });
      users.push(user.id);
    }
    const session = await client.refreshSession.create({
      data: {
        userId: users[0]!,
        tokenHash: refreshHash(newRefreshToken()),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    const identity = { sub: String(users[0]), sid: String(session.id), cv: 1 };
    const grant = async (permissionCode: string, scopeCode: ScopeCode) => {
      let permission = await client.permission.findUnique({ where: { code: permissionCode } });
      if (!permission) {
        permission = await client.permission.create({
          data: { code: permissionCode, description: 'foundation fixture' },
        });
        permissions.push(permission.id);
      }
      const role = await client.role.create({
        data: { code: `foundation-${randomUUID()}`, name: 'foundation fixture' },
      });
      roles.push(role.id);
      await client.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id, scopeCode },
      });
      await client.userRole.create({ data: { userId: users[0]!, roleId: role.id } });
      return role.id;
    };
    // No Customer table: a test-only repository projects ownership from existing M0 FK relations.
    // The resolver reads the authoritative User row in the exact transaction passed by the service.
    const root: SalesRootResolver = async (tx) => {
      const target = await tx.user.findUnique({ where: { id: users[1]! }, select: { id: true } });
      return target ? { ownerId: target.id, collaboratorIds: [] } : null;
    };
    await app.init();
    await work({ client, app, users, departments, identity, grant, root });
  } finally {
    try {
      await app.close();
    } finally {
      try {
        await client.auditLog.deleteMany({
          where: {
            OR: [
              { actorId: { in: users } },
              { entityType: 'user', entityId: { in: users.map(String) } },
            ],
          },
        });
        await client.commandAttempt.deleteMany({ where: { actorId: { in: users } } });
        await client.idempotencyRecord.deleteMany({
          where: { scope: { in: users.map((id) => `user:${id}`) } },
        });
        await client.userRole.deleteMany({ where: { userId: { in: users } } });
        await client.rolePermission.deleteMany({ where: { roleId: { in: roles } } });
        await client.role.deleteMany({ where: { id: { in: roles } } });
        await client.permission.deleteMany({ where: { id: { in: permissions } } });
        await client.refreshSession.deleteMany({ where: { userId: { in: users } } });
        await client.user.deleteMany({ where: { id: { in: users } } });
        // Reverse dependency order: outside, child, parent.
        for (const id of [...departments].reverse())
          await client.department.delete({ where: { id } });
      } finally {
        await client.$disconnect();
      }
    }
  }
}

test('real MySQL: backend sales authorization denies before reading payload, follows current TEAM and revoked membership', async () => {
  await fixture(async ({ client, app, identity, users, departments, grant, root }) => {
    const service = app.get(SalesAuthorizationService);
    let payloadRead = false;
    const read = async () => {
      payloadRead = true;
      return 'allowed';
    };
    await assert.rejects(
      service.withObjectRead(identity, 'customer:read', root, read),
      code('PERMISSION_DENIED'),
    );
    assert.equal(payloadRead, false);
    const roleId = await grant('customer:read', 'TEAM');
    assert.equal(await service.withObjectRead(identity, 'customer:read', root, read), 'allowed');
    await client.user.update({ where: { id: users[1]! }, data: { departmentId: departments[2]! } });
    payloadRead = false;
    await assert.rejects(
      service.withObjectRead(identity, 'customer:read', root, read),
      code('RESOURCE_NOT_FOUND'),
    );
    assert.equal(payloadRead, false);
    await client.user.update({ where: { id: users[1]! }, data: { departmentId: departments[1]! } });
    await client.userRole.delete({ where: { userId_roleId: { userId: users[0]!, roleId } } });
    await assert.rejects(
      service.withObjectRead(identity, 'customer:read', root, read),
      code('PERMISSION_DENIED'),
    );
    await grant('customer:read', 'SELF_COLLABORATOR');
    await assert.rejects(
      service.withObjectRead(identity, 'customer:read', root, read),
      code('RESOURCE_NOT_FOUND'),
    );
    assert.equal(
      await service.withObjectRead(
        identity,
        'customer:read',
        async (tx) => {
          const actor = await tx.user.findUniqueOrThrow({ where: { id: users[0]! } });
          return { ownerId: users[1]!, collaboratorIds: [actor.id] };
        },
        read,
      ),
      'allowed',
    );
    await assert.rejects(
      service.withObjectRead(identity, 'order:approve', root, read),
      code('PERMISSION_DENIED'),
    );
  });
});

test('real MySQL: TEAM fails closed for disabled hierarchy, cycles, null roots and revoked sessions', async () => {
  await fixture(async ({ client, app, identity, users, departments, grant, root }) => {
    await grant('quote:read', 'TEAM');
    const service = app.get(SalesAuthorizationService);
    const read = async () => true;
    await client.department.update({
      where: { id: departments[0]! },
      data: { status: 'DISABLED' },
    });
    await assert.rejects(
      service.withObjectRead(identity, 'quote:read', root, read),
      code('RESOURCE_NOT_FOUND'),
    );
    await client.department.update({
      where: { id: departments[0]! },
      data: { status: 'ACTIVE', parentId: departments[1]! },
    });
    try {
      await assert.rejects(
        service.withObjectRead(identity, 'quote:read', root, read),
        code('SERVICE_UNAVAILABLE'),
      );
    } finally {
      await client.department.update({ where: { id: departments[0]! }, data: { parentId: null } });
    }
    await assert.rejects(
      service.withObjectRead(identity, 'quote:read', async () => null, read),
      code('RESOURCE_NOT_FOUND'),
    );
    await client.user.update({
      where: { id: users[0]! },
      data: { credentialVersion: { increment: 1 } },
    });
    await assert.rejects(
      service.withObjectRead(identity, 'quote:read', root, read),
      code('UNAUTHENTICATED'),
    );
  });
});

test('real MySQL: identity lock plan detects new memberships, and held user/role locks serialize revocation', async () => {
  await fixture(async ({ client, app, identity, users, grant }) => {
    const service = app.get(WriteLockService);
    const audit = app.get(AuditService);
    const plan = await client.$transaction((tx) => service.plan(tx, identity));
    const roleId = await grant('customer:read', 'TEAM');
    await assert.rejects(
      audit.withTransaction(client, (tx) => service.acquire(tx, identity, plan), {
        isolationLevel: 'ReadCommitted',
      }),
      code('VERSION_CONFLICT'),
    );
    const current = await client.$transaction((tx) => service.plan(tx, identity));
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = audit.withTransaction(
      client,
      async (tx) => {
        await service.acquire(tx, identity, current);
        locked();
        await gate;
      },
      { isolationLevel: 'ReadCommitted', timeout: 10000 },
    );
    try {
      await Promise.race([
        ready,
        holder.then(() => {
          throw new Error('Lock readiness missing');
        }),
      ]);
      await assert.rejects(
        client.$transaction(
          (tx) =>
            new IdempotencyStore().withWaitLimit(tx, async () => {
              await tx.$queryRaw`SELECT id FROM users WHERE id = ${users[0]!} FOR UPDATE`;
              await tx.userRole.delete({ where: { userId_roleId: { userId: users[0]!, roleId } } });
            }),
          { timeout: 5000 },
        ),
        /lock wait timeout/i,
      );
      await assert.rejects(
        client.$transaction(
          (tx) =>
            new IdempotencyStore().withWaitLimit(tx, async () => {
              await tx.$queryRaw`SELECT id FROM roles WHERE id = ${roleId} FOR UPDATE`;
              await tx.rolePermission.updateMany({ where: { roleId }, data: { scopeCode: 'ALL' } });
            }),
          { timeout: 5000 },
        ),
        /lock wait timeout/i,
      );
    } finally {
      release();
      await holder;
    }
    await client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${users[0]!} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM roles WHERE id = ${roleId} FOR UPDATE`;
      await tx.userRole.delete({ where: { userId_roleId: { userId: users[0]!, roleId } } });
    });
    const authorization = app.get(AuthorizationService);
    assert.equal(
      (await client.$transaction((tx) => authorization.inTransaction(tx, identity))).grants.length,
      0,
    );
  });
});

test('real MySQL: created entity, real audit target, attempt and replay agree; audit failure rolls everything back', async () => {
  await fixture(async ({ client, app, identity, users }) => {
    const service = app.get(IdempotencyService);
    const audit = app.get(AuditService);
    const loginName = `foundation-create-${randomUUID()}`;
    const input = {
      identity,
      createsEntity: true,
      key: randomUUID(),
      requestId: randomUUID(),
      operationId: 'test.createUser',
      entityType: 'user',
      entityId: 'new',
      targets: {},
      dto: { name: 'created fixture' },
      responseFields: ['id', 'version'],
      authorize: async () => {},
      execute: async (tx: Prisma.TransactionClient) => {
        const user = await tx.user.create({
          data: { loginName, name: 'created fixture', passwordHash: 'no-login' },
        });
        users.push(user.id);
        return { httpStatus: 201, body: { id: String(user.id), version: user.version } };
      },
    };
    const [first, replay] = await Promise.all([
      service.execute(input),
      service.execute({ ...input, requestId: randomUUID() }),
    ]);
    assert.deepEqual([first.replayed, replay.replayed].sort(), [false, true]);
    assert.deepEqual(replay.body, first.body);
    const id = String(first.body!.id);
    const rows = await client.auditLog.findMany({ where: { actorId: BigInt(identity.sub) } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.entityId, id);
    const attempts = await client.commandAttempt.findMany({
      where: { actorId: BigInt(identity.sub) },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(attempts.map(({ status }) => status).sort(), ['REPLAYED', 'SUCCEEDED']);
    assert.ok(attempts.every((item) => item.entityId === 'new' && item.resultRef === `user:${id}`));
    const original = audit.recordSuccess.bind(audit);
    audit.recordSuccess = async () => {
      throw new ApiException('AUDIT_UNAVAILABLE', 'Audit unavailable');
    };
    try {
      await assert.rejects(
        service.execute({
          ...input,
          key: randomUUID(),
          execute: async (tx) => {
            const created = await tx.user.create({
              data: {
                loginName: `${loginName}-rollback`,
                name: 'rollback',
                passwordHash: 'no-login',
              },
            });
            users.push(created.id);
            return { httpStatus: 201, body: { id: String(created.id), version: 1 } };
          },
        }),
        code('AUDIT_UNAVAILABLE'),
      );
    } finally {
      audit.recordSuccess = original;
    }
    assert.equal(await client.user.count({ where: { loginName: `${loginName}-rollback` } }), 0);
    assert.equal(
      await client.idempotencyRecord.count({ where: { scope: `user:${identity.sub}` } }),
      1,
    );
    await client.user.update({
      where: { id: BigInt(identity.sub) },
      data: { credentialVersion: { increment: 1 } },
    });
    await assert.rejects(service.execute(input), code('UNAUTHENTICATED'));
  });
});

test('real MySQL: lost creation commit acknowledgement recovers the generated ID without a second insert', async () => {
  await fixture(async ({ client, app, identity, users }) => {
    const service = app.get(IdempotencyService);
    const audit = app.get(AuditService);
    const database = app.get(PrismaService);
    const original = audit.withTransaction.bind(audit);
    let inject = true;
    let calls = 0;
    audit.withTransaction = async (db, work, options) => {
      const result = await original(db, work, options);
      if (db === database.client && inject) {
        inject = false;
        throw new Error('injected lost acknowledgement');
      }
      return result;
    };
    try {
      const result = await service.execute({
        identity,
        createsEntity: true,
        key: randomUUID(),
        requestId: randomUUID(),
        operationId: 'test.createRecover',
        entityType: 'user',
        entityId: 'new',
        targets: {},
        dto: {},
        responseFields: ['id'],
        authorize: async () => {},
        execute: async (tx) => {
          calls++;
          const user = await tx.user.create({
            data: {
              loginName: `recover-${randomUUID()}`,
              name: 'recovery fixture',
              passwordHash: 'no-login',
            },
          });
          users.push(user.id);
          return { httpStatus: 201, body: { id: String(user.id) } };
        },
      });
      assert.equal(result.replayed, true);
      assert.equal(calls, 1);
      const success = await client.auditLog.findMany({ where: { actorId: BigInt(identity.sub) } });
      assert.equal(success.length, 1);
      assert.equal(success[0]!.entityId, result.body!.id);
    } finally {
      audit.withTransaction = original;
    }
  });
});

test('real MySQL: bounded attempt reconciliation requires matching result AND same-attempt success evidence', async () => {
  await fixture(async ({ client, users }) => {
    const ids: bigint[] = [];
    const attemptIds: string[] = [];
    const scope = `user:${users[0]}`;
    const cutoff = new Date(Date.now() - 600000);
    const hash = createHash('sha256').update(randomUUID()).digest('hex');
    for (let index = 0; index < 6; index++) {
      const attempt = await client.commandAttempt.create({
        data: {
          attemptId: randomUUID(),
          actorId: users[0]!,
          operationId: 'test.reconcile',
          entityType: 'user',
          entityId: String(users[1]),
          requestId: randomUUID(),
          idempotencyScope: scope,
          idempotencyKey: randomUUID(),
          requestHash: hash,
          startedAt: cutoff,
          status: index === 3 ? 'SUCCEEDED' : 'STARTED',
          resultRef: `user:${users[1]}`,
        },
      });
      ids.push(attempt.id);
      attemptIds.push(attempt.attemptId);
      if (index < 2 || index > 3)
        await client.idempotencyRecord.create({
          data: {
            scope,
            key: attempt.idempotencyKey,
            requestHash:
              index === 5 ? createHash('sha256').update('different').digest('hex') : hash,
            status: 'COMPLETED',
            httpStatus: index === 4 ? null : 201,
            responseBody: { id: String(users[1]) },
            completedAt: new Date(),
            expiresAt: new Date(Date.now() + 86400000),
          },
        });
      if (index === 0 || index > 3)
        await client.auditLog.create({
          data: {
            actorId: users[0]!,
            action: attempt.operationId,
            entityType: attempt.entityType,
            entityId: attempt.entityId,
            requestId: attempt.requestId,
            attemptId: attempt.attemptId,
          },
        });
    }
    // Start immediately before our rows; unrelated older local attempts are never visited.
    const service = new AttemptReconciliationService(new IdempotencyStore());
    const result = await service.runBatch(client, ids[0]! - 1n, new Date(), attemptIds);
    assert.equal(result.examined, 5);
    const rows = await client.commandAttempt.findMany({
      where: { id: { in: ids } },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(
      rows.map(({ status }) => status),
      ['SUCCEEDED', 'UNKNOWN', 'UNKNOWN', 'SUCCEEDED', 'UNKNOWN', 'UNKNOWN'],
    );
    assert.equal(
      (await service.runBatch(client, BigInt(result.nextCursor!), new Date(), attemptIds)).examined,
      0,
    );
  });
});

test('real MySQL: bootstrap admits one first owner concurrently, uses scrypt, never overwrites or recovers a disabled owner', async () => {
  const client = createPrismaClient(localDatabaseUrl());
  const { app } = await createApplication(loadEnvironment(), false);
  const prefix = `bootstrap-fixture-${randomUUID()}`;
  const password = randomBytes(32).toString('base64url');
  const createdIds: bigint[] = [];
  try {
    const role = await client.role.findUniqueOrThrow({ where: { code: 'business_owner' } });
    // Never remove existing owners to make this test pass. Use an approved isolated local test database.
    assert.equal(
      await client.userRole.count({ where: { roleId: role.id } }),
      0,
      'Bootstrap integration requires an isolated database without provisioned owners',
    );
    const service = new BootstrapIdentityService(app.get(AuditService));
    const results = await Promise.allSettled(
      [0, 1].map((index) =>
        service.initialize(client, {
          loginName: `${prefix}-${index}`,
          name: 'bootstrap fixture',
          password,
        }),
      ),
    );
    const accounts = await client.user.findMany({ where: { loginName: { startsWith: prefix } } });
    createdIds.push(...accounts.map(({ id }) => id));
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(accounts.length, 1);
    assert.equal(await verifyPassword(password, accounts[0]!.passwordHash), true);
    assert.equal(
      await client.userRole.count({ where: { userId: accounts[0]!.id, roleId: role.id } }),
      1,
    );
    const success = await client.auditLog.findMany({
      where: {
        systemActor: 'bootstrap:identity',
        entityType: 'user',
        entityId: String(accounts[0]!.id),
      },
    });
    assert.equal(success.length, 1);
    assert.ok(!JSON.stringify(success[0]!.afterJson).includes(password));
    await client.user.update({ where: { id: accounts[0]!.id }, data: { status: 'DISABLED' } });
    await assert.rejects(
      service.initialize(client, { loginName: `${prefix}-recovery`, name: 'no bypass', password }),
      code('BUSINESS_RULE_VIOLATION'),
    );
    assert.equal(
      (await client.user.findUniqueOrThrow({ where: { id: accounts[0]!.id } })).passwordHash,
      accounts[0]!.passwordHash,
    );
  } finally {
    try {
      await app.close();
    } finally {
      for (const account of await client.user.findMany({
        where: { loginName: { startsWith: prefix } },
        select: { id: true },
      }))
        if (!createdIds.includes(account.id)) createdIds.push(account.id);
      const audits = await client.auditLog.findMany({
        where: {
          entityType: 'user',
          entityId: { in: createdIds.map(String) },
          systemActor: 'bootstrap:identity',
        },
        select: { attemptId: true },
      });
      await client.auditLog.deleteMany({
        where: {
          entityType: 'user',
          entityId: { in: createdIds.map(String) },
          systemActor: 'bootstrap:identity',
        },
      });
      const hashes = [0, 1].map((index) =>
        createHash('sha256')
          .update(JSON.stringify({ loginName: `${prefix}-${index}`, name: 'bootstrap fixture' }))
          .digest('hex'),
      );
      await client.commandAttempt.deleteMany({
        where: {
          systemActor: 'bootstrap:identity',
          OR: [
            {
              attemptId: { in: audits.flatMap(({ attemptId }) => (attemptId ? [attemptId] : [])) },
            },
            { requestHash: { in: hashes } },
          ],
        },
      });
      await client.userRole.deleteMany({ where: { userId: { in: createdIds } } });
      await client.user.deleteMany({ where: { id: { in: createdIds } } });
      await client.$disconnect();
    }
  }
});

test('real MySQL: bootstrap audit failure rolls back both account and protected role membership', async () => {
  const client = createPrismaClient(localDatabaseUrl());
  const { app } = await createApplication(loadEnvironment(), false);
  const loginName = `bootstrap-failure-${randomUUID()}`;
  const name = 'bootstrap failure fixture';
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ loginName, name }))
    .digest('hex');
  const audit = app.get(AuditService);
  const original = audit.recordSuccess.bind(audit);
  try {
    const role = await client.role.findUniqueOrThrow({ where: { code: 'business_owner' } });
    assert.equal(
      await client.userRole.count({ where: { roleId: role.id } }),
      0,
      'Use an isolated unbootstrapped database',
    );
    audit.recordSuccess = async () => {
      throw new ApiException('AUDIT_UNAVAILABLE', 'Injected audit failure');
    };
    await assert.rejects(
      new BootstrapIdentityService(audit).initialize(client, {
        loginName,
        name,
        password: randomBytes(32).toString('base64url'),
      }),
      code('AUDIT_UNAVAILABLE'),
    );
    assert.equal(await client.user.count({ where: { loginName } }), 0);
    assert.equal(await client.userRole.count({ where: { roleId: role.id } }), 0);
    const attempts = await client.commandAttempt.findMany({
      where: { systemActor: 'bootstrap:identity', requestHash },
    });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, 'UNKNOWN');
    assert.equal(await client.auditLog.count({ where: { attemptId: attempts[0]!.attemptId } }), 0);
  } finally {
    audit.recordSuccess = original;
    try {
      await app.close();
    } finally {
      await client.commandAttempt.deleteMany({
        where: { systemActor: 'bootstrap:identity', requestHash },
      });
      await client.$disconnect();
    }
  }
});
