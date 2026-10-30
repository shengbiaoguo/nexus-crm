import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApplication } from '../../src/application.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { localDatabaseUrl } from '../../src/database/local-database.js';
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js';
import { hashPassword } from '../../src/auth/auth.crypto.js';
import type { ReferenceObject, SchemaObject } from '@nestjs/swagger';

// Deliberately limited to the response schema features used by current M0 endpoints.
// Unknown features fail instead of silently skipping contract checks.
function matches(
  value: unknown,
  input: SchemaObject | ReferenceObject,
  schemas: Record<string, SchemaObject | ReferenceObject>,
): void {
  if ('$ref' in input) {
    const schema = schemas[input.$ref.split('/').at(-1)!];
    assert.ok(schema, input.$ref);
    return matches(value, schema, schemas);
  }
  assert.equal(input.allOf, undefined);
  assert.equal(input.anyOf, undefined);
  if (value === null && input.nullable) return;
  if (input.oneOf) {
    const matching = input.oneOf.filter((candidate) => {
      try {
        matches(value, candidate, schemas);
        return true;
      } catch (error) {
        if (error instanceof assert.AssertionError) return false;
        throw error;
      }
    });
    assert.equal(matching.length, 1);
    return;
  }
  if (input.enum) assert.ok(input.enum.includes(value));
  switch (input.type) {
    case 'object': {
      assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
      const object = value as Record<string, unknown>;
      for (const field of input.required ?? []) assert.ok(Object.hasOwn(object, field), field);
      for (const [field, item] of Object.entries(object)) {
        const property = input.properties?.[field];
        if (!property && input.additionalProperties === true) continue;
        assert.ok(property, `Undocumented response field: ${field}`);
        matches(item, property, schemas);
      }
      break;
    }
    case 'array':
      assert.ok(Array.isArray(value));
      assert.ok(input.items);
      for (const item of value) matches(item, input.items, schemas);
      break;
    case 'string':
      assert.equal(typeof value, 'string');
      if (input.format === 'uuid') assert.match(String(value), /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
      if (input.format === 'date-time') assert.equal(new Date(String(value)).toISOString(), value);
      break;
    case 'number':
    case 'integer':
      assert.equal(typeof value, 'number');
      assert.ok(Number.isFinite(value));
      if (input.type === 'integer') assert.ok(Number.isInteger(value));
      break;
    default:
      assert.fail(`Unsupported M0 schema type: ${String(input.type)}`);
  }
}

test('M0 integrated HTTP/MySQL: real login, documented reads, live revocation, refresh, logout and correlated audit', async () => {
  const client = createPrismaClient(localDatabaseUrl());
  const { app, document } = await createApplication(
    {
      ...loadEnvironment(),
      AUTH_JWT_SECRET: randomBytes(32).toString('base64url'),
    },
    false,
  );
  const users: bigint[] = [];
  let roleId: bigint | undefined;
  let departmentId: bigint | undefined;
  const permissionIds: bigint[] = [];
  const password = 'integration fixture password';
  const loginName = `m0-integration-${randomUUID()}`;
  const requestIds = new Set<string>();
  try {
    const department = await client.department.create({ data: { name: loginName } });
    departmentId = department.id;
    const actor = await client.user.create({
      data: {
        loginName,
        name: 'M0 integration actor',
        passwordHash: await hashPassword(password),
        departmentId,
      },
    });
    users.push(actor.id);
    const target = await client.user.create({
      data: {
        loginName: `${loginName}-target`,
        name: 'M0 integration target',
        passwordHash: 'no-login',
      },
    });
    users.push(target.id);
    const role = await client.role.create({ data: { code: loginName, name: loginName } });
    roleId = role.id;
    for (const [code, scopeCode] of [
      ['user:manage', 'IDENTITY'],
      ['role:manage', 'IDENTITY'],
      ['department:read', 'AUTHENTICATED'],
    ] as const) {
      let permission = await client.permission.findUnique({ where: { code } });
      if (!permission) {
        permission = await client.permission.create({
          data: { code, description: 'M0 integration' },
        });
        permissionIds.push(permission.id);
      }
      await client.rolePermission.create({
        data: { roleId, permissionId: permission.id, scopeCode },
      });
    }
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const call = async (
      path: string,
      status: number,
      token?: string,
      body?: unknown,
    ): Promise<Record<string, unknown>> => {
      const method = body !== undefined || path === 'auth/logout' ? 'post' : 'get';
      const response = await fetch(`${origin}/api/v1/${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'untrusted-client-id',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, status, path);
      const requestId = response.headers.get('x-request-id');
      assert.ok(requestId && requestId !== 'untrusted-client-id');
      assert.ok(!requestIds.has(requestId));
      requestIds.add(requestId);
      const route = `/api/v1/${path.split('?')[0]!.replace(/users\/\d+$/, 'users/{id}')}`;
      const operation = document.paths[route]?.[method];
      assert.ok(operation, route);
      const declared = operation.responses[String(status)];
      assert.ok(declared && !('$ref' in declared), `${route}: ${status}`);
      if (status === 204) {
        assert.equal(await response.text(), '');
        return { requestId };
      }
      const result = (await response.json()) as Record<string, unknown>;
      assert.equal(result.requestId, requestId);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      const schema = declared.content?.['application/json']?.schema;
      assert.ok(schema);
      matches(result, schema, document.components?.schemas ?? {});
      if (status === 200) assert.equal(response.headers.get('cache-control'), 'no-store');
      return result;
    };
    const login = await call('auth/login', 200, undefined, {
      loginName: ` ${loginName} `,
      password,
    });
    const first = login!.data as { accessToken: string; refreshToken: string };
    assert.equal((login!.data as { tokenType: string }).tokenType, 'Bearer');
    assert.equal((login!.data as { expiresIn: number }).expiresIn, 900);
    const me = await call('auth/me', 200, first.accessToken);
    assert.deepEqual((me!.data as { permissions: unknown[] }).permissions, []);
    await call('users', 403, first.accessToken);
    await call(`users/${target.id}`, 404, first.accessToken);
    await call(`users/${actor.id}`, 200, first.accessToken);
    await client.userRole.create({ data: { userId: actor.id, roleId } });
    const granted = await call('auth/me', 200, first.accessToken);
    assert.equal((granted!.data as { permissions: unknown[] }).permissions.length, 3);
    for (const path of ['users', 'roles', 'permissions', 'departments']) {
      const list = await call(`${path}?page=1&pageSize=100`, 200, first.accessToken);
      const meta = list!.meta as {
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
      };
      assert.equal(meta.page, 1);
      assert.equal(meta.pageSize, 100);
      assert.equal(meta.totalPages, Math.ceil(meta.total / 100));
      const rows = list!.data as { id: string }[];
      assert.ok(rows.length > 0);
      for (const row of rows) assert.equal(typeof row.id, 'string');
    }
    await call(`users/${target.id}`, 200, first.accessToken);
    await call('users?actorId=1', 400, first.accessToken);
    await call('users/01', 400, first.accessToken);
    await client.userRole.delete({ where: { userId_roleId: { userId: actor.id, roleId } } });
    await call('users', 403, first.accessToken);
    const refreshed = await call('auth/refresh', 200, undefined, {
      refreshToken: first.refreshToken,
    });
    const next = refreshed!.data as { accessToken: string; refreshToken: string };
    await call('roles', 403, next.accessToken);
    await call('auth/refresh', 401, undefined, { refreshToken: first.refreshToken });
    const logout = await call('auth/logout', 204, next.accessToken);
    await call(`users/${actor.id}`, 401, first.accessToken);
    await call('auth/me', 401, next.accessToken);
    const audits = await client.auditLog.findMany({
      where: { actorId: actor.id },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(
      audits.map(({ action }) => action),
      ['auth.login', 'auth.refresh', 'auth.logout'],
    );
    assert.deepEqual(
      audits.map(({ requestId }) => requestId),
      [login!.requestId, refreshed!.requestId, logout!.requestId],
    );
    const serialized = JSON.stringify(
      audits.map(({ beforeJson, afterJson }) => ({ beforeJson, afterJson })),
    );
    for (const secret of [password, first.accessToken, first.refreshToken, next.refreshToken]) {
      assert.ok(!serialized.includes(secret));
    }
    assert.equal(await client.commandAttempt.count({ where: { actorId: actor.id } }), 0);
    assert.equal(await client.idempotencyRecord.count({ where: { scope: `user:${actor.id}` } }), 0);
  } finally {
    try {
      await app.close();
    } finally {
      try {
        await client.auditLog.deleteMany({ where: { actorId: { in: users } } });
        await client.refreshSession.deleteMany({ where: { userId: { in: users } } });
        await client.userRole.deleteMany({ where: { userId: { in: users } } });
        if (roleId !== undefined) {
          await client.rolePermission.deleteMany({ where: { roleId } });
          await client.role.delete({ where: { id: roleId } });
        }
        await client.permission.deleteMany({ where: { id: { in: permissionIds } } });
        await client.user.deleteMany({ where: { id: { in: users } } });
        if (departmentId !== undefined)
          await client.department.delete({ where: { id: departmentId } });
      } finally {
        await client.$disconnect();
      }
    }
  }
});
