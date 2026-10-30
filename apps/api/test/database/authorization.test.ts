import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApplication } from '../../src/application.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { localDatabaseUrl } from '../../src/database/local-database.js';
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js';
import { PrismaService } from '../../src/infrastructure/prisma.service.js';
import { AccessTokens, newRefreshToken, refreshHash } from '../../src/auth/auth.crypto.js';
import type { ScopeCode } from '../../src/generated/prisma/enums.js';
import type { INestApplication } from '@nestjs/common';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { ApiException } from '../../src/http/api.exception.js';

async function fixture(
  work: (context: {
    client: ReturnType<typeof createPrismaClient>;
    app: INestApplication;
    actorId: bigint;
    targetId: bigint;
    token: string;
    get: (path: string) => Promise<Response>;
    grant: (code: string, scope: ScopeCode) => Promise<bigint>;
  }) => Promise<void>,
) {
  const client = createPrismaClient(localDatabaseUrl());
  const secret = randomBytes(32).toString('base64url');
  const { app } = await createApplication({ ...loadEnvironment(), AUTH_JWT_SECRET: secret }, false);
  const userIds: bigint[] = [];
  const roleIds: bigint[] = [];
  const newPermissionIds: bigint[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const user = await client.user.create({
        data: {
          loginName: `rbac-${randomUUID()}`,
          name: 'authorization fixture',
          passwordHash: 'test-only-no-login',
        },
      });
      userIds.push(user.id);
    }
    const actorId = userIds[0]!;
    const targetId = userIds[1]!;
    const session = await client.refreshSession.create({
      data: {
        userId: actorId,
        tokenHash: refreshHash(newRefreshToken()),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    const token = await new AccessTokens(secret).sign({
      sub: String(actorId),
      sid: String(session.id),
      cv: 1,
    });
    const grant = async (code: string, scopeCode: ScopeCode) => {
      let permission = await client.permission.findUnique({ where: { code } });
      if (!permission) {
        permission = await client.permission.create({
          data: { code, description: 'isolated authorization fixture' },
        });
        newPermissionIds.push(permission.id);
      }
      const role = await client.role.create({
        data: { code: `rbac-${randomUUID()}`, name: 'authorization fixture' },
      });
      roleIds.push(role.id);
      await client.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id, scopeCode },
      });
      await client.userRole.create({ data: { roleId: role.id, userId: actorId } });
      return role.id;
    };
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const get = (path: string) =>
      fetch(`${origin}/api/v1/${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    await work({ client, app, actorId, targetId, token, get, grant });
  } finally {
    await app.close();
    // Only delete these randomly named fixtures, never seed or real account data.
    await client.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await client.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
    await client.role.deleteMany({ where: { id: { in: roleIds } } });
    await client.permission.deleteMany({ where: { id: { in: newPermissionIds } } });
    await client.refreshSession.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  }
}

test('real MySQL HTTP: ordinary user cannot read others or management lists; self projection omits secrets', async () => {
  await fixture(async ({ client, app, actorId, targetId, get }) => {
    assert.equal(
      app.get(PrismaService, { each: true }).length,
      1,
      'Auth and authorization share one pool owner',
    );
    const before = await client.user.findUniqueOrThrow({ where: { id: targetId } });
    const own = await get(`users/${actorId}`);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('cache-control'), 'no-store');
    const profile = ((await own.json()) as { data: Record<string, unknown> }).data;
    assert.deepEqual(Object.keys(profile).sort(), ['departmentId', 'id', 'loginName', 'name']);
    assert.equal(profile.id, String(actorId));
    const other = await get(`users/${targetId}`);
    const absent = await get('users/18446744073709551615');
    assert.equal(other.status, 404);
    assert.equal(absent.status, 404);
    assert.equal(((await other.json()) as { code: string }).code, 'RESOURCE_NOT_FOUND');
    for (const path of ['users', 'roles', 'permissions', 'departments']) {
      const response = await get(path);
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as { code: string }).code, 'PERMISSION_DENIED');
    }
    assert.deepEqual(await client.user.findUniqueOrThrow({ where: { id: targetId } }), before);
    assert.equal(await client.auditLog.count({ where: { actorId } }), 0);
    assert.equal(await client.commandAttempt.count({ where: { actorId } }), 0);
  });
});

test('real MySQL HTTP: permissions are paired with scope and are not combined across roles', async () => {
  await fixture(async ({ client, targetId, get, grant }) => {
    await grant('audit:read', 'IDENTITY');
    const wrong = await grant('user:manage', 'ALL');
    assert.equal((await get('users')).status, 403);
    assert.equal((await get(`users/${targetId}`)).status, 404);
    await client.rolePermission.updateMany({
      where: { roleId: wrong },
      data: { scopeCode: 'IDENTITY' },
    });
    assert.equal((await get('users')).status, 200);
    assert.equal((await get(`users/${targetId}`)).status, 200);
    // user:manage never implies role:manage, even when the first grant is valid.
    assert.equal((await get('roles')).status, 403);
    await grant('role:grant_business', 'IDENTITY');
    assert.equal((await get('permissions')).status, 403);
    await grant('role:manage', 'IDENTITY');
    assert.equal((await get('roles')).status, 200);
    assert.equal((await get('permissions')).status, 200);
  });
});

test('real MySQL HTTP: role disable, grant replacement and membership revocation take effect for the same JWT', async () => {
  await fixture(async ({ client, actorId, targetId, get, grant }) => {
    const roleId = await grant('user:manage', 'IDENTITY');
    assert.equal((await get(`users/${targetId}`)).status, 200);
    await client.role.update({ where: { id: roleId }, data: { status: 'DISABLED' } });
    assert.equal((await get('users')).status, 403);
    assert.equal((await get(`users/${targetId}`)).status, 404);
    await client.role.update({ where: { id: roleId }, data: { status: 'ACTIVE' } });
    await client.rolePermission.updateMany({ where: { roleId }, data: { scopeCode: 'TEAM' } });
    assert.equal((await get('users')).status, 403);
    await client.rolePermission.updateMany({ where: { roleId }, data: { scopeCode: 'IDENTITY' } });
    assert.equal((await get('users')).status, 200);
    await client.userRole.delete({ where: { userId_roleId: { userId: actorId, roleId } } });
    assert.equal((await get('users')).status, 403);
    assert.equal((await get(`users/${actorId}`)).status, 200);
    await client.user.update({ where: { id: actorId }, data: { status: 'DISABLED' } });
    assert.equal((await get(`users/${actorId}`)).status, 401);
  });
});

test('real MySQL HTTP: pagination, IDs, unknown fields and response projections are enforced', async () => {
  await fixture(async ({ actorId, targetId, get, grant }) => {
    await grant('user:manage', 'IDENTITY');
    await grant('role:manage', 'IDENTITY');
    await grant('department:read', 'AUTHENTICATED');
    for (const path of ['users', 'roles', 'permissions', 'departments']) {
      const response = await get(`${path}?page=1&pageSize=1`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        data: Record<string, unknown>[];
        meta: { page: number; pageSize: number; total: number };
      };
      assert.equal(body.meta.page, 1);
      assert.equal(body.meta.pageSize, 1);
      assert.ok(body.data.length <= 1);
      const fields =
        path === 'users'
          ? ['id', 'name', 'loginName', 'departmentId']
          : path === 'roles'
            ? ['id', 'code', 'name', 'status', 'version']
            : path === 'permissions'
              ? ['id', 'code', 'description']
              : ['id', 'name', 'parentId'];
      for (const item of body.data) assert.deepEqual(Object.keys(item).sort(), fields.sort());
    }
    for (const suffix of [
      'page=0',
      'pageSize=101',
      'page=-1',
      'pageSize=1.5',
      'page=1&page=2',
      'scope=ALL',
      'actorId=1',
      'page=1000001',
      'sortBy=passwordHash',
    ]) {
      assert.equal((await get(`users?${suffix}`)).status, 400, suffix);
    }
    for (const id of ['0', '-1', '01', '1.5', '18446744073709551616']) {
      assert.equal((await get(`users/${id}`)).status, 400, id);
    }
    assert.equal((await get(`users/${actorId}`)).status, 200);
    const first = await get('users?pageSize=100');
    const body = (await first.json()) as { data: { id: string }[] };
    assert.ok(body.data.some(({ id }) => id === String(targetId)));
  });
});

test('real MySQL: revocation committed during an earlier read denies new reads and service rechecks session', async () => {
  await fixture(async ({ client, app, actorId, targetId, get, grant }) => {
    const roleId = await grant('user:manage', 'IDENTITY');
    const authorization = app.get(AuthorizationService);
    const session = await client.refreshSession.findFirstOrThrow({ where: { userId: actorId } });
    const identity = { sub: String(actorId), sid: String(session.id), cv: 1 };
    let prepared!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const earlier = authorization.withRead(identity, async (tx, context) => {
      authorization.require(context, 'user:manage');
      prepared();
      await gate;
      return tx.user.findUnique({ where: { id: targetId }, select: { id: true } });
    });
    try {
      await Promise.race([
        ready,
        earlier.then(() => {
          throw new Error('Read did not signal readiness');
        }),
      ]);
      await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${actorId} FOR UPDATE`;
        await tx.userRole.delete({ where: { userId_roleId: { userId: actorId, roleId } } });
      });
      assert.equal((await get('users')).status, 403);
    } finally {
      release();
      await earlier;
    }
    // The already running read keeps its snapshot; no promise to revoke data already read.
    assert.equal((await earlier)?.id, targetId);
    await client.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    let invoked = false;
    await assert.rejects(
      authorization.withRead(identity, async () => {
        invoked = true;
      }),
      (error: unknown) => error instanceof ApiException && error.code === 'UNAUTHENTICATED',
    );
    assert.equal(invoked, false);
  });
});
