import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createApplication } from '../../src/application.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { localDatabaseUrl } from '../../src/database/local-database.js';
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js';
import {
  AccessTokens,
  hashPassword,
  verifyPassword,
  newRefreshToken,
  refreshHash,
} from '../../src/auth/auth.crypto.js';
import type { AccessIdentity } from '../../src/auth/auth.crypto.js';
import { ProvisionIdentityService } from '../../src/database/provision-identity.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { IdentityWriteService } from '../../src/authorization/identity-write.service.js';
import { IdempotencyService } from '../../src/idempotency/idempotency.service.js';
import { IdempotencyStore } from '../../src/idempotency/idempotency.store.js';
import { WriteLockService } from '../../src/authorization/write-lock.service.js';
import { ApiException } from '../../src/http/api.exception.js';

type Client = ReturnType<typeof createPrismaClient>;
type Application = Awaited<ReturnType<typeof createApplication>>['app'];
type Reply = {
  status: number;
  headers: Headers;
  body: { code?: string; data?: { id: string; status: string; version: number } };
};
interface Context {
  client: Client;
  app: Application;
  users: bigint[];
  identities: AccessIdentity[];
  ownerId: bigint;
  adminId: bigint;
  salesId: bigint;
  tokens: string[];
  call: (
    actor: number,
    target: number,
    action: string,
    body: unknown,
    key?: string,
  ) => Promise<Reply>;
  base: string;
  password: string;
}
const input = (roleIds?: bigint[], expectedVersion = 1) => ({
  expectedVersion,
  reason: 'T01 fixture',
  ...(roleIds ? { roleIds: roleIds.map(String) } : {}),
});
const errorCode = (code: string) => (error: unknown) =>
  error instanceof ApiException && error.code === code;

test('T01 real MySQL: explicit provisioning creates unassigned hashed accounts once, never overwrites or recovers, and audits atomically', async () => {
  await fixture(async ({ app, client, users, call, password }) => {
    const audit = app.get(AuditService);
    const service = new ProvisionIdentityService(audit);
    const loginName = `t01-provision-${randomUUID()}`;
    const raceLogin = `t01-provision-${randomUUID()}`;
    const name = 'T01 provisioning fixture';
    const hashes = [loginName, raceLogin].map((login) =>
      createHash('sha256')
        .update(JSON.stringify({ loginName: login, name }))
        .digest('hex'),
    );
    const original = audit.recordSuccess;
    try {
      const result = await service.create(client, { loginName, name, password });
      users.push(BigInt(result.id));
      const created = await client.user.findUniqueOrThrow({ where: { id: BigInt(result.id) } });
      assert.equal(await verifyPassword(password, created.passwordHash), true);
      assert.equal(await client.userRole.count({ where: { userId: created.id } }), 0);
      assert.equal((await call(0, users.length - 1, 'disable', input())).status, 200);
      await assert.rejects(
        service.create(client, { loginName, name, password: `${password}different` }),
        errorCode('BUSINESS_RULE_VIOLATION'),
      );
      assert.equal(
        (await client.user.findUniqueOrThrow({ where: { id: created.id } })).passwordHash,
        created.passwordHash,
      );
      await assert.rejects(
        service.create(client, { loginName: raceLogin, name, password, roleIds: ['1'] }),
        errorCode('VALIDATION_FAILED'),
      );
      const raced = await Promise.allSettled([
        service.create(client, { loginName: raceLogin, name, password }),
        service.create(client, { loginName: raceLogin, name, password }),
      ]);
      assert.equal(raced.filter(({ status }) => status === 'fulfilled').length, 1);
      const winner = await client.user.findUniqueOrThrow({ where: { loginName: raceLogin } });
      users.push(winner.id);
      const success = await client.auditLog.findFirstOrThrow({
        where: { systemActor: 'provision:identity', entityId: String(winner.id) },
      });
      assert.ok(!JSON.stringify(success.afterJson).includes(password));
      // An audit outage rolls a new account back; same login remains available for an explicit retry.
      await client.user.update({
        where: { id: winner.id },
        data: { loginName: `${raceLogin}-retained` },
      });
      audit.recordSuccess = async () => {
        throw new ApiException('AUDIT_UNAVAILABLE', 'fixture');
      };
      await assert.rejects(
        service.create(client, { loginName: raceLogin, name, password }),
        errorCode('AUDIT_UNAVAILABLE'),
      );
      assert.equal(await client.user.count({ where: { loginName: raceLogin } }), 0);
    } finally {
      audit.recordSuccess = original;
      const attempts = await client.commandAttempt.findMany({
        where: { systemActor: 'provision:identity', requestHash: { in: hashes } },
        select: { attemptId: true },
      });
      await client.auditLog.deleteMany({
        where: { attemptId: { in: attempts.map(({ attemptId }) => attemptId) } },
      });
      await client.commandAttempt.deleteMany({
        where: { attemptId: { in: attempts.map(({ attemptId }) => attemptId) } },
      });
    }
  });
});
async function fixture(work: (context: Context) => Promise<void>) {
  const client = createPrismaClient(localDatabaseUrl());
  const secret = randomBytes(32).toString('base64url');
  const { app, document } = await createApplication(
    { ...loadEnvironment(), AUTH_JWT_SECRET: secret },
    false,
  );
  const users: bigint[] = [];
  const identities: AccessIdentity[] = [];
  const tokens: string[] = [];
  const password = randomBytes(32).toString('base64url');
  try {
    const owner = await client.role.findUniqueOrThrow({ where: { code: 'business_owner' } });
    const admin = await client.role.findUniqueOrThrow({ where: { code: 'system_admin' } });
    const sales = await client.role.findUniqueOrThrow({ where: { code: 'sales' } });
    assert.equal(
      await client.userRole.count({ where: { roleId: owner.id } }),
      0,
      'T01 tests require an approved isolated database without existing owners; never remove real owners',
    );
    const passwordHash = await hashPassword(password);
    for (const roles of [[admin.id], [owner.id, admin.id], [owner.id, admin.id], [sales.id]]) {
      const user = await client.user.create({
        data: { loginName: `t01-${randomUUID()}`, name: 'T01 fixture', passwordHash },
      });
      users.push(user.id);
      await client.userRole.createMany({
        data: roles.map((roleId) => ({ userId: user.id, roleId })),
      });
      const session = await client.refreshSession.create({
        data: {
          userId: user.id,
          tokenHash: refreshHash(newRefreshToken()),
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      const identity = { sub: String(user.id), sid: String(session.id), cv: 1 };
      identities.push(identity);
      tokens.push(await new AccessTokens(secret).sign(identity));
    }
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    for (const action of ['assign-roles', 'disable']) {
      const operation = document.paths[`/api/v1/users/{id}/${action}`]?.post;
      assert.ok(operation?.responses['200']);
      assert.ok(operation?.security?.length);
      assert.ok(operation?.responses['409']);
    }
    const call: Context['call'] = async (actor, target, action, body, key = randomUUID()) => {
      const response = await fetch(`${base}/users/${users[target]}/${action}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens[actor]}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        headers: response.headers,
        body: (await response.json()) as Reply['body'],
      };
    };
    await work({
      client,
      app,
      users,
      identities,
      ownerId: owner.id,
      adminId: admin.id,
      salesId: sales.id,
      tokens,
      call,
      base,
      password,
    });
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
        await client.refreshSession.deleteMany({ where: { userId: { in: users } } });
        await client.userRole.deleteMany({ where: { userId: { in: users } } });
        await client.user.deleteMany({ where: { id: { in: users } } });
      } finally {
        await client.$disconnect();
      }
    }
  }
}

test('T01 real HTTP: admin cannot self-grant business powers or disable protected owners; unimplemented editing stays closed', async () => {
  await fixture(async ({ call, base, tokens, users, salesId, ownerId, client }) => {
    const state = await fetch(`${base}/users/${users[3]}/access-state`, {
      headers: { authorization: `Bearer ${tokens[1]}` },
    });
    assert.equal(state.status, 200);
    const summary = (await state.json()) as { data: { version: number; roleIds: string[] } };
    assert.deepEqual(Object.keys(summary.data).sort(), ['id', 'roleIds', 'status', 'version']);
    assert.equal(summary.data.version, 1);
    assert.deepEqual(summary.data.roleIds, [String(salesId)]);
    assert.equal(
      (
        await fetch(`${base}/users/${users[3]}/access-state`, {
          headers: { authorization: `Bearer ${tokens[3]}` },
        })
      ).status,
      403,
    );
    for (const roles of [[salesId], [ownerId]]) {
      const response = await call(0, 0, 'assign-roles', input(roles));
      assert.equal(response.status, 403);
    }
    assert.equal((await call(0, 1, 'disable', input())).status, 403);
    assert.equal((await call(3, 0, 'assign-roles', input([]))).status, 403);
    assert.equal((await call(1, 1, 'assign-roles', input([]))).status, 403);
    const anonymous = await fetch(`${base}/users/${users[3]}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input()),
    });
    assert.equal(anonymous.status, 401);
    for (const [method, path, body] of [
      ['PATCH', `users/${users[0]}`, { departmentId: '1' }],
      ['PUT', `roles/${ownerId}/permissions`, { permissions: [] }],
      ['PATCH', `roles/${ownerId}`, { status: 'DISABLED' }],
    ] as const) {
      assert.equal(
        (
          await fetch(`${base}/${path}`, {
            method,
            headers: { authorization: `Bearer ${tokens[0]}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status,
        404,
      );
    }
    assert.equal(
      (await call(1, 3, 'assign-roles', { ...input([]), status: 'ACTIVE' })).status,
      400,
    );
    assert.equal((await call(1, 3, 'assign-roles', { ...input([]), roleIds: [1] })).status, 400);
    assert.equal((await call(1, 3, 'disable', { ...input(), expectedVersion: '1' })).status, 400);
    assert.equal(
      await client.auditLog.count({
        where: { actorId: { in: users }, action: { startsWith: 'identity.' } },
      }),
      0,
    );
  });
});

test('T01 real MySQL: controlled role replacement is versioned, audited and idempotent; revocation affects the same token', async () => {
  await fixture(async ({ call, client, users, salesId, adminId, ownerId, tokens, base }) => {
    const key = randomUUID();
    const assigned = await call(1, 3, 'assign-roles', input([salesId, adminId]), key);
    assert.equal(assigned.status, 200);
    assert.deepEqual(Object.keys(assigned.body.data!).sort(), ['id', 'status', 'version']);
    assert.equal(assigned.body.data?.version, 2);
    // Equivalent role set order is normalized before the v1 fingerprint.
    const replay = await call(1, 3, 'assign-roles', input([adminId, salesId]), key);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(replay.body.data, assigned.body.data);
    assert.equal(
      (await call(1, 3, 'assign-roles', input([ownerId]), key)).body.code,
      'IDEMPOTENCY_KEY_REUSED',
    );
    assert.equal((await call(1, 3, 'assign-roles', input([]))).body.code, 'VERSION_CONFLICT');
    assert.equal(
      (await fetch(`${base}/users`, { headers: { authorization: `Bearer ${tokens[3]}` } })).status,
      200,
    );
    assert.equal((await call(1, 3, 'assign-roles', input([salesId], 2))).status, 200);
    assert.equal(
      (await fetch(`${base}/users`, { headers: { authorization: `Bearer ${tokens[3]}` } })).status,
      403,
    );
    const audits = await client.auditLog.findMany({
      where: { actorId: users[1]!, action: 'identity.assignRoles' },
    });
    assert.equal(audits.length, 2);
    assert.ok(audits.every((row) => row.entityId === String(users[3]) && row.attemptId));
    assert.equal(await client.user.count({ where: { id: users[3]!, credentialVersion: 1 } }), 1);
  });
});

test('T01 real MySQL: business role removal replay still requires current protected grant after target loses that role', async () => {
  await fixture(async ({ call, client, users, adminId }) => {
    const key = randomUUID();
    assert.equal((await call(1, 3, 'assign-roles', input([]), key)).status, 200);
    assert.equal(
      (await call(1, 3, 'assign-roles', input([]), key)).headers.get('idempotency-replayed'),
      'true',
    );
    assert.equal((await call(2, 1, 'assign-roles', input([adminId]))).status, 200);
    const replay = await call(1, 3, 'assign-roles', input([]), key);
    assert.equal(replay.status, 403);
    assert.equal(await client.userRole.count({ where: { userId: users[3]! } }), 0);
  });
});

test('T01 real HTTP: disable increments cv, revokes all refresh sessions, denies access/login/refresh and preserves history', async () => {
  await fixture(async ({ call, client, users, base, password, tokens }) => {
    const target = await client.user.findUniqueOrThrow({ where: { id: users[3]! } });
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginName: target.loginName, password }),
    });
    assert.equal(login.status, 200);
    const pair = (await login.json()) as { data: { accessToken: string; refreshToken: string } };
    const key = randomUUID();
    // An ordinary admin may disable a sales account; only protected accounts need the extra grant.
    assert.equal((await call(0, 3, 'disable', input(), key)).status, 200);
    const updated = await client.user.findUniqueOrThrow({ where: { id: users[3]! } });
    assert.equal(updated.status, 'DISABLED');
    assert.equal(updated.credentialVersion, 2);
    assert.equal(updated.version, 2);
    assert.equal(
      await client.refreshSession.count({ where: { userId: updated.id, revokedAt: null } }),
      0,
    );
    for (const token of [tokens[3], pair.data.accessToken])
      assert.equal(
        (await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status,
        401,
      );
    for (const [path, body] of [
      ['login', { loginName: target.loginName, password }],
      ['refresh', { refreshToken: pair.data.refreshToken }],
    ] as const) {
      assert.equal(
        (
          await fetch(`${base}/auth/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status,
        401,
      );
    }
    assert.equal(
      (await call(0, 3, 'disable', input(), key)).headers.get('idempotency-replayed'),
      'true',
    );
    assert.equal(
      (await call(0, 3, 'disable', input(undefined, 2))).body.code,
      'BUSINESS_RULE_VIOLATION',
    );
    assert.ok(await client.auditLog.findFirst({ where: { actorId: users[3]! } }));
    assert.equal(await client.userRole.count({ where: { userId: users[3]! } }), 1);
  });
});

for (const action of ['assign-roles', 'disable']) {
  test(`T01 real MySQL: two owners concurrently ${action} each other leave one effective owner`, async () => {
    await fixture(async ({ call, client, ownerId }) => {
      const results = await Promise.all([
        call(1, 2, action, action === 'disable' ? input() : input([])),
        call(2, 1, action, action === 'disable' ? input() : input([])),
      ]);
      assert.equal(results.filter(({ status }) => status === 200).length, 1);
      assert.ok(results.some(({ status }) => status === 401 || status === 403 || status === 409));
      assert.equal(
        await client.user.count({
          where: { status: 'ACTIVE', roles: { some: { roleId: ownerId } } },
        }),
        1,
      );
    });
  });
}

test('T01 real MySQL: audit fault rolls back membership, version, status, cv and session revocation', async () => {
  await fixture(async ({ app, client, identities, users, ownerId, adminId }) => {
    const audit = app.get(AuditService);
    const original = audit.recordSuccess;
    audit.recordSuccess = async () => {
      throw new ApiException('AUDIT_UNAVAILABLE', 'fixture');
    };
    try {
      const service = app.get(IdentityWriteService);
      for (const work of [
        () =>
          service.assignRoles(
            identities[1]!,
            String(users[3]),
            input([ownerId, adminId]) as {
              roleIds: string[];
              expectedVersion: number;
              reason: string;
            },
            randomUUID(),
            randomUUID(),
          ),
        () =>
          service.disable(identities[0]!, String(users[3]), input(), randomUUID(), randomUUID()),
      ])
        await assert.rejects(work(), errorCode('AUDIT_UNAVAILABLE'));
      const target = await client.user.findUniqueOrThrow({ where: { id: users[3]! } });
      assert.equal(target.version, 1);
      assert.equal(target.status, 'ACTIVE');
      assert.equal(target.credentialVersion, 1);
      assert.equal(
        await client.refreshSession.count({ where: { userId: target.id, revokedAt: null } }),
        1,
      );
      assert.equal(
        await client.userRole.count({ where: { userId: target.id, roleId: ownerId } }),
        0,
      );
      assert.equal(
        await client.idempotencyRecord.count({
          where: { scope: { in: [`user:${users[0]}`, `user:${users[1]}`] } },
        }),
        0,
      );
      assert.equal(
        await client.commandAttempt.count({ where: { actorId: { in: users }, status: 'FAILED' } }),
        2,
      );
    } finally {
      audit.recordSuccess = original;
    }
  });
});

test('T01 real MySQL: an actual intervening role command invalidates the earlier complete lock plan', async () => {
  await fixture(async ({ app, client, call, users, salesId }) => {
    const commands = app.get(IdempotencyService);
    const original = commands.execute.bind(commands);
    const finance = await client.role.findUniqueOrThrow({ where: { code: 'finance' } });
    let changed = false;
    commands.execute = async (command) => {
      if (!changed) {
        changed = true;
        const service = app.get(IdentityWriteService);
        await service.assignRoles(
          {
            sub: String(users[2]),
            sid: (
              await client.refreshSession.findFirstOrThrow({ where: { userId: users[2]! } })
            ).id.toString(),
            cv: 1,
          },
          String(users[3]),
          {
            expectedVersion: 1,
            reason: 'intervening authorized command',
            roleIds: [salesId.toString(), finance.id.toString()],
          },
          randomUUID(),
          randomUUID(),
        );
      }
      return original(command);
    };
    try {
      assert.equal((await call(1, 3, 'disable', input())).body.code, 'VERSION_CONFLICT');
      const target = await client.user.findUniqueOrThrow({ where: { id: users[3]! } });
      assert.equal(target.status, 'ACTIVE');
      assert.equal(target.version, 2);
      assert.equal(
        await client.userRole.count({ where: { userId: target.id, roleId: finance.id } }),
        1,
      );
    } finally {
      commands.execute = original;
    }
  });
});

test('T01 real MySQL: a writer waiting for the protected role already holds the target user lock', async () => {
  await fixture(async ({ app, client, call, users, ownerId }) => {
    let releaseRole!: () => void;
    let signalRole!: () => void;
    let signalUsers!: () => void;
    const roleHeld = new Promise<void>((resolve) => {
      signalRole = resolve;
    });
    const usersHeld = new Promise<void>((resolve) => {
      signalUsers = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRole = resolve;
    });
    const holder = client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM roles WHERE id=${ownerId} FOR UPDATE`;
        signalRole();
        await release;
      },
      { timeout: 15000 },
    );
    const locks = app.get(WriteLockService);
    const original = locks.acquire.bind(locks);
    locks.acquire = async (tx, identity, plan) => {
      signalUsers();
      await original(tx, identity, plan);
    };
    let pending: Promise<Reply> | undefined;
    try {
      await roleHeld;
      pending = call(1, 3, 'disable', input());
      await usersHeld;
      await assert.rejects(
        client.$transaction(
          (tx) =>
            new IdempotencyStore().withWaitLimit(
              tx,
              () => tx.$queryRaw`SELECT id FROM users WHERE id=${users[3]!} FOR UPDATE`,
            ),
          { timeout: 5000 },
        ),
        (error: unknown) => error instanceof Error && /lock wait timeout/i.test(error.message),
      );
      releaseRole();
      await holder;
      assert.equal((await pending).status, 200);
    } finally {
      releaseRole();
      await holder;
      await pending;
      locks.acquire = original;
    }
  });
});
