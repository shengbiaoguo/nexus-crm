import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Prisma } from '../../src/generated/prisma/client.js';
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js';
import { localDatabaseUrl } from '../../src/database/local-database.js';

const client = createPrismaClient(localDatabaseUrl());
after(async () => {
  await client.$disconnect();
});
class FixtureRollback extends Error {}
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
async function rollbackFixture(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  await assert.rejects(
    client.$transaction(
      async (tx) => {
        await work(tx);
        throw new FixtureRollback();
      },
      { timeout: 20000 },
    ),
    FixtureRollback,
  );
}
const uniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
const foreignKeyViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';

test('real MySQL tables, types, migration checksum, RESTRICT FKs and actor CHECKs match reviewed migration', async () => {
  const tables = await client.$queryRaw<
    Array<{ name: string }>
  >`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`;
  assert.deepEqual(
    tables.map((row) => row.name),
    [
      '_prisma_migrations',
      'audit_logs',
      'command_attempts',
      'departments',
      'idempotency_records',
      'permissions',
      'refresh_sessions',
      'role_permissions',
      'roles',
      'user_roles',
      'users',
    ],
  );
  const constraints = await client.$queryRaw<
    Array<{ delete_rule: string; update_rule: string }>
  >`SELECT DELETE_RULE AS delete_rule, UPDATE_RULE AS update_rule FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()`;
  assert.equal(constraints.length, 10);
  assert.ok(
    constraints.every((row) => row.delete_rule === 'RESTRICT' && row.update_rule === 'RESTRICT'),
  );
  const checks = await client.$queryRaw<
    Array<{ name: string }>
  >`SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK'`;
  assert.deepEqual(checks.map((row) => row.name).sort(), [
    'audit_logs_actor_check',
    'command_attempts_actor_check',
  ]);
  const columns = await client.$queryRaw<
    Array<{ name: string; type: string }>
  >`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'`;
  assert.equal(columns.find((column) => column.name === 'id')?.type, 'bigint unsigned');
  assert.equal(columns.find((column) => column.name === 'created_at')?.type, 'datetime(3)');
  const sql = await readFile('prisma/migrations/20261030014538_init_m0/migration.sql');
  const migration = await client.$queryRaw<
    Array<{ checksum: string; finished_at: Date | null }>
  >`SELECT checksum, finished_at FROM _prisma_migrations WHERE migration_name='20261030014538_init_m0'`;
  assert.equal(migration[0]?.checksum, createHash('sha256').update(sql).digest('hex'));
  assert.ok(migration[0]?.finished_at);
});

test('identity uniqueness, FK protection and historical disabled actors; fixture always rolls back', async () => {
  await rollbackFixture(async (tx) => {
    const suffix = randomUUID();
    const department = await tx.department.create({ data: { name: `test-${suffix}` } });
    const user = await tx.user.create({
      data: {
        loginName: `test-${suffix}`,
        passwordHash: hash(),
        name: 'fixture',
        departmentId: department.id,
      },
    });
    const role = await tx.role.create({ data: { code: `test-${suffix}`, name: 'fixture' } });
    const permission = await tx.permission.create({
      data: { code: `test:${suffix}`, description: 'fixture' },
    });
    await assert.rejects(
      tx.user.create({
        data: { loginName: user.loginName.toUpperCase(), name: 'duplicate', passwordHash: hash() },
      }),
      uniqueViolation,
    );
    await assert.rejects(
      tx.role.create({ data: { code: role.code, name: 'duplicate' } }),
      uniqueViolation,
    );
    await assert.rejects(
      tx.permission.create({ data: { code: permission.code, description: 'duplicate' } }),
      uniqueViolation,
    );
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    await assert.rejects(
      tx.userRole.create({ data: { userId: user.id, roleId: role.id } }),
      uniqueViolation,
    );
    await tx.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id, scopeCode: 'IDENTITY' },
    });
    await assert.rejects(
      tx.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id, scopeCode: 'ALL' },
      }),
      uniqueViolation,
    );
    await assert.rejects(
      tx.userRole.create({ data: { userId: 18446744073709551615n, roleId: role.id } }),
      foreignKeyViolation,
    );
    const tokenHash = hash();
    await tx.refreshSession.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 60000) },
    });
    await assert.rejects(
      tx.refreshSession.create({ data: { userId: user.id, tokenHash, expiresAt: new Date() } }),
      uniqueViolation,
    );
    await tx.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    const audit = await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: 'test',
        entityType: 'user',
        entityId: String(user.id),
        requestId: suffix,
      },
    });
    assert.equal(
      (await tx.auditLog.findUniqueOrThrow({ where: { id: audit.id }, include: { actor: true } }))
        .actor?.status,
      'DISABLED',
    );
    await assert.rejects(tx.user.delete({ where: { id: user.id } }), foreignKeyViolation);
    await assert.rejects(
      tx.department.delete({ where: { id: department.id } }),
      foreignKeyViolation,
    );
  });
});

test('UTC millisecond and JSON null round trips; database rejects anonymous audit', async () => {
  await rollbackFixture(async (tx) => {
    const zones = await tx.$queryRaw<Array<{ zone: string }>>`SELECT @@session.time_zone AS zone`;
    assert.equal(zones[0]?.zone, '+00:00');
    const data = {
      systemActor: 'test:m0',
      action: 'test',
      entityType: 'test',
      entityId: randomUUID(),
      requestId: randomUUID(),
    };
    const instant = new Date('2026-10-30T10:20:30.123+08:00');
    const sqlNull = await tx.auditLog.create({
      data: {
        ...data,
        beforeJson: Prisma.DbNull,
        afterJson: { id: '18446744073709551615', at: instant.toISOString() },
        createdAt: instant,
      },
    });
    const jsonNull = await tx.auditLog.create({ data: { ...data, beforeJson: Prisma.JsonNull } });
    assert.equal(sqlNull.createdAt.toISOString(), instant.toISOString());
    assert.deepEqual(sqlNull.afterJson, { id: '18446744073709551615', at: instant.toISOString() });
    const nulls = await tx.$queryRaw<
      Array<{ sql_null: bigint; json_type: string | null }>
    >`SELECT before_json IS NULL AS sql_null, JSON_TYPE(before_json) AS json_type FROM audit_logs WHERE id IN (${sqlNull.id}, ${jsonNull.id}) ORDER BY id`;
    assert.equal(Number(nulls[0]?.sql_null), 1);
    assert.equal(nulls[1]?.json_type, 'NULL');
    await assert.rejects(
      tx.auditLog.create({
        data: { action: 'test', entityType: 'test', entityId: 'test', requestId: randomUUID() },
      }),
    );
    await assert.rejects(
      tx.commandAttempt.create({
        data: {
          attemptId: randomUUID(),
          operationId: 'test',
          entityType: 'test',
          entityId: 'test',
          requestId: randomUUID(),
          idempotencyScope: 'test',
          idempotencyKey: randomUUID(),
          requestHash: hash(),
        },
      }),
    );
  });
});

test('same scope/key has one concurrent owner; different scopes are independent', async () => {
  const scope = `test:${randomUUID()}`;
  const key = randomUUID();
  const data = {
    scope,
    key,
    requestHash: hash(),
    expiresAt: new Date(Date.now() + 60000),
    status: 'COMPLETED' as const,
    httpStatus: 200,
    responseBody: { ok: true },
    completedAt: new Date(),
  };
  try {
    const results = await Promise.allSettled([
      client.$transaction((tx) => tx.idempotencyRecord.create({ data })),
      client.$transaction((tx) => tx.idempotencyRecord.create({ data })),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.ok(
      results.some((result) => result.status === 'rejected' && uniqueViolation(result.reason)),
    );
    assert.equal(await client.idempotencyRecord.count({ where: { scope, key } }), 1);
    await rollbackFixture(async (tx) => {
      await tx.idempotencyRecord.create({ data: { ...data, scope: `${scope}:other` } });
    });
  } finally {
    await client.idempotencyRecord.deleteMany({ where: { scope, key } });
  }
});

test('rollback removes business/audit/idempotency success but preserves separately prewritten attempt', async () => {
  const attemptId = randomUUID();
  const scope = `test:${randomUUID()}`;
  const attempt = await client.commandAttempt.create({
    data: {
      attemptId,
      systemActor: 'test:m0',
      operationId: 'test',
      entityType: 'test',
      entityId: scope,
      requestId: attemptId,
      idempotencyScope: scope,
      idempotencyKey: randomUUID(),
      requestHash: hash(),
    },
  });
  try {
    await rollbackFixture(async (tx) => {
      await tx.user.create({
        data: { loginName: scope, name: 'rollback fixture', passwordHash: hash() },
      });
      await tx.auditLog.create({
        data: {
          systemActor: 'test:m0',
          attemptId,
          action: 'test',
          entityType: 'test',
          entityId: scope,
          requestId: attemptId,
        },
      });
      await tx.idempotencyRecord.create({
        data: {
          scope,
          key: attempt.idempotencyKey,
          requestHash: hash(),
          expiresAt: new Date(),
          status: 'COMPLETED',
        },
      });
      await tx.commandAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCEEDED' } });
    });
    assert.equal(await client.user.count({ where: { loginName: scope } }), 0);
    assert.equal(await client.auditLog.count({ where: { attemptId } }), 0);
    assert.equal(await client.idempotencyRecord.count({ where: { scope } }), 0);
    assert.equal(
      (await client.commandAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      'STARTED',
    );
  } finally {
    await client.commandAttempt.delete({ where: { id: attempt.id } });
  }
});
