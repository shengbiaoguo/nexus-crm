import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasPermission, userReadWhere } from '../src/authorization/permission.policy.js';
import { createApplication } from '../src/application.js';
import { validateEnvironment } from '../src/config/environment.js';
import { PrismaService } from '../src/infrastructure/prisma.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { ApiException } from '../src/http/api.exception.js';

test('permission policy defaults to deny and pairs each action with its own scope', () => {
  assert.equal(hasPermission([], 'user:manage'), false);
  assert.equal(
    hasPermission([{ roleId: '1', code: 'user:manage', scopeCode: 'IDENTITY' }], 'user:manage'),
    true,
  );
  assert.equal(
    hasPermission(
      [
        { roleId: '1', code: 'user:manage', scopeCode: 'ALL' },
        { roleId: '2', code: 'audit:read', scopeCode: 'IDENTITY' },
      ],
      'user:manage',
    ),
    false,
  );
  assert.equal(
    hasPermission([{ roleId: 'system_admin', code: '*', scopeCode: 'ALL' }], 'user:manage'),
    false,
  );
  assert.equal(
    hasPermission([{ roleId: '1', code: 'order:approve', scopeCode: 'ALL' }], 'order:approve'),
    false,
  );
  assert.equal(
    hasPermission(
      [{ roleId: '1', code: 'role:grant_business', scopeCode: 'IDENTITY' }],
      'role:manage',
    ),
    false,
  );
  assert.equal(
    hasPermission([{ roleId: '1', code: 'department:read', scopeCode: 'ALL' }], 'department:read'),
    false,
  );
  assert.equal(
    hasPermission([{ roleId: '1', code: 'toString', scopeCode: 'IDENTITY' }], 'toString'),
    false,
  );
  assert.deepEqual(userReadWhere(9007199254740993n, []), { id: 9007199254740993n });
  assert.deepEqual(
    userReadWhere(1n, [{ roleId: '1', code: 'user:manage', scopeCode: 'IDENTITY' }]),
    {},
  );
});

test('all M0 read endpoints require authentication and export their actual response schemas without DB', async () => {
  const { app, document } = await createApplication(
    validateEnvironment({
      DATABASE_URL: 'mysql://unused:unused@127.0.0.1:1/unused',
      REDIS_URL: 'redis://127.0.0.1:1',
      CORS_ORIGIN: 'http://localhost:5173',
    }),
    false,
  );
  try {
    await app.listen(0, '127.0.0.1');
    for (const path of ['users', 'users/1', 'roles', 'permissions', 'departments']) {
      const response = await fetch(`${await app.getUrl()}/api/v1/${path}`);
      assert.equal(response.status, 401);
    }
    for (const path of ['users', 'roles', 'permissions', 'departments']) {
      const operation = document.paths[`/api/v1/${path}`]?.get;
      assert.ok(operation?.security?.length);
      assert.ok(operation.responses['200']);
      assert.ok(operation.responses['401']);
      assert.ok(operation.responses['403']);
    }
    assert.ok(document.paths['/api/v1/users/{id}']?.get?.responses['404']);
    assert.ok(document.components?.schemas?.UserProfileDto);
  } finally {
    await app.close();
  }
});

test('authorization dependency failure fails closed without returning underlying credentials', async () => {
  const database = new PrismaService('unused');
  Object.defineProperty(database, 'client', {
    get: () => {
      throw new Error('private-database-credential');
    },
  });
  const authorization = new AuthorizationService(database);
  let invoked = false;
  await assert.rejects(
    authorization.withRead({ sub: '1', sid: '1', cv: 1 }, async () => {
      invoked = true;
    }),
    (error: unknown) =>
      error instanceof ApiException &&
      error.getStatus() === 503 &&
      !error.message.includes('private-database-credential'),
  );
  assert.equal(invoked, false);
});
