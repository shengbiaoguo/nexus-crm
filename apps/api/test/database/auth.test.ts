import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApplication } from '../../src/application.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { localDatabaseUrl } from '../../src/database/local-database.js';
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js';
import { hashPassword, refreshHash } from '../../src/auth/auth.crypto.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { ApiException } from '../../src/http/api.exception.js';

interface Pair {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

async function fixture(
  work: (context: {
    client: ReturnType<typeof createPrismaClient>;
    userId: bigint;
    loginName: string;
    call: (path: string, body?: unknown, access?: string) => Promise<Response>;
    login: () => Promise<Pair>;
    audit: AuditService;
  }) => Promise<void>,
) {
  const client = createPrismaClient(localDatabaseUrl());
  const environment = {
    ...loadEnvironment(),
    AUTH_JWT_SECRET: randomBytes(32).toString('base64url'),
  };
  const { app } = await createApplication(environment, false);
  const loginName = `auth-test-${randomUUID()}`;
  const user = await client.user.create({
    data: { loginName, passwordHash: await hashPassword('fixture password'), name: 'auth fixture' },
  });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1/auth`;
    const call = (path: string, body?: unknown, access?: string) =>
      fetch(`${base}/${path}`, {
        method: path === 'me' ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          ...(access ? { authorization: `Bearer ${access}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const login = async () => {
      const response = await call('login', { loginName, password: 'fixture password' });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return ((await response.json()) as { data: Pair }).data;
    };
    await work({ client, userId: user.id, loginName, call, login, audit: app.get(AuditService) });
  } finally {
    await app.close();
    await client.auditLog.deleteMany({ where: { actorId: user.id } });
    await client.refreshSession.deleteMany({ where: { userId: user.id } });
    await client.user.delete({ where: { id: user.id } });
    await client.$disconnect();
  }
}

test('real MySQL HTTP: login, generic credential failures, refresh rotation and logout isolate sessions', async () => {
  await fixture(async ({ client, userId, loginName, call, login }) => {
    const bad = await call('login', { loginName, password: 'wrong' });
    const missing = await call('login', { loginName: randomUUID(), password: 'wrong' });
    assert.equal(bad.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(
      ((await bad.json()) as { message: string }).message,
      ((await missing.json()) as { message: string }).message,
    );
    assert.equal(await client.refreshSession.count({ where: { userId } }), 0);
    const first = await login();
    const independent = await login();
    assert.equal((await call('me', undefined, first.accessToken)).status, 200);
    const stored = await client.refreshSession.findUniqueOrThrow({
      where: { tokenHash: refreshHash(first.refreshToken) },
    });
    assert.notEqual(stored.tokenHash, first.refreshToken);
    const response = await call('refresh', { refreshToken: first.refreshToken });
    assert.equal(response.status, 200);
    const next = ((await response.json()) as { data: Pair }).data;
    assert.notEqual(first.refreshToken, next.refreshToken);
    assert.equal(first.refreshExpiresAt, next.refreshExpiresAt);
    assert.equal((await call('refresh', { refreshToken: first.refreshToken })).status, 401);
    const logout = await call('logout', undefined, next.accessToken);
    assert.equal(logout.status, 204);
    assert.equal(await logout.text(), '');
    assert.equal((await call('me', undefined, first.accessToken)).status, 401);
    assert.equal((await call('me', undefined, next.accessToken)).status, 401);
    assert.equal((await call('refresh', { refreshToken: next.refreshToken })).status, 401);
    assert.equal((await call('me', undefined, independent.accessToken)).status, 200);
    const actions = await client.auditLog.findMany({ where: { actorId: userId } });
    assert.deepEqual(actions.map((item) => item.action).sort(), [
      'auth.login',
      'auth.login',
      'auth.logout',
      'auth.refresh',
    ]);
    assert.ok(
      !JSON.stringify(
        actions.map(({ beforeJson, afterJson }) => ({ beforeJson, afterJson })),
      ).includes(first.refreshToken),
    );
  });
});

test('real MySQL HTTP: disabled account and credential version reject login, access and refresh', async () => {
  await fixture(async ({ client, userId, loginName, call, login }) => {
    const pair = await login();
    // Isolated fixture simulates the future authorized disable command under its shared user lock.
    await client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      await tx.user.update({
        where: { id: userId },
        data: { status: 'DISABLED', credentialVersion: { increment: 1 } },
      });
      await tx.refreshSession.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
    });
    assert.equal((await call('login', { loginName, password: 'fixture password' })).status, 401);
    assert.equal((await call('me', undefined, pair.accessToken)).status, 401);
    assert.equal((await call('refresh', { refreshToken: pair.refreshToken })).status, 401);
    await client.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
    assert.equal((await call('me', undefined, pair.accessToken)).status, 401);
    const fresh = await login();
    await client.user.update({
      where: { id: userId },
      data: { credentialVersion: { increment: 1 } },
    });
    assert.equal((await call('me', undefined, fresh.accessToken)).status, 401);
    // Test status check independently, even if a future caller forgot to revoke sessions.
    await client.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
    assert.equal((await call('refresh', { refreshToken: fresh.refreshToken })).status, 401);
  });
});

test('real MySQL HTTP: concurrent refresh consumes a token once; refresh/logout race stays revoked', async () => {
  await fixture(async ({ client, userId, call, login }) => {
    const pair = await login();
    const responses = await Promise.all([
      call('refresh', { refreshToken: pair.refreshToken }),
      call('refresh', { refreshToken: pair.refreshToken }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
    const next = (
      (await responses.find((response) => response.status === 200)!.json()) as { data: Pair }
    ).data;
    const [renewed, loggedOut] = await Promise.all([
      call('refresh', { refreshToken: next.refreshToken }),
      call('logout', undefined, next.accessToken),
    ]);
    assert.equal(loggedOut.status, 204);
    assert.ok([200, 401].includes(renewed.status));
    if (renewed.status === 200) {
      const last = ((await renewed.json()) as { data: Pair }).data;
      assert.equal((await call('refresh', { refreshToken: last.refreshToken })).status, 401);
      assert.equal((await call('me', undefined, last.accessToken)).status, 401);
    }
    assert.equal(await client.refreshSession.count({ where: { userId, revokedAt: null } }), 0);
  });
});

test('real MySQL HTTP: expired session denied and audit failure rolls back authentication writes', async () => {
  await fixture(async ({ client, userId, loginName, call, login, audit }) => {
    const pair = await login();
    const original = audit.recordSuccess.bind(audit);
    audit.recordSuccess = async () => {
      throw new ApiException('AUDIT_UNAVAILABLE', 'Audit persistence unavailable');
    };
    try {
      assert.equal((await call('login', { loginName, password: 'fixture password' })).status, 503);
      assert.equal(await client.refreshSession.count({ where: { userId } }), 1);
      assert.equal((await call('refresh', { refreshToken: pair.refreshToken })).status, 503);
      assert.ok(
        await client.refreshSession.findUnique({
          where: { tokenHash: refreshHash(pair.refreshToken) },
        }),
      );
      assert.equal((await call('logout', undefined, pair.accessToken)).status, 503);
      assert.equal((await call('me', undefined, pair.accessToken)).status, 200);
    } finally {
      audit.recordSuccess = original;
    }
    await client.refreshSession.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await call('me', undefined, pair.accessToken)).status, 401);
    assert.equal((await call('refresh', { refreshToken: pair.refreshToken })).status, 401);
  });
});
