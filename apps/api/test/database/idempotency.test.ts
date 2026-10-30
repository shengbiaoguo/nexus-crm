import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApplication } from '../../src/application.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { localDatabaseUrl } from '../../src/database/local-database.js';
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js';
import { PrismaService } from '../../src/infrastructure/prisma.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { IdempotencyService } from '../../src/idempotency/idempotency.service.js';
import type { IdempotentCommand } from '../../src/idempotency/idempotency.service.js';
import { IdempotencyStore } from '../../src/idempotency/idempotency.store.js';
import { ApiException } from '../../src/http/api.exception.js';
import { newRefreshToken, refreshHash } from '../../src/auth/auth.crypto.js';
import type { AccessIdentity } from '../../src/auth/auth.crypto.js';

const code = (expected: string) => (error: unknown) =>
  error instanceof ApiException && error.code === expected;

async function fixture(
  work: (context: {
    client: ReturnType<typeof createPrismaClient>;
    database: PrismaService;
    audit: AuditService;
    service: IdempotencyService;
    store: IdempotencyStore;
    targetId: bigint;
    actors: AccessIdentity[];
    command: (options?: Partial<IdempotentCommand>) => IdempotentCommand;
    roleId: bigint;
  }) => Promise<void>,
) {
  const client = createPrismaClient(localDatabaseUrl());
  const { app } = await createApplication(
    { ...loadEnvironment(), AUTH_JWT_SECRET: randomBytes(32).toString('base64url') },
    false,
  );
  const ids: bigint[] = [];
  const scopes: string[] = [];
  let roleId: bigint | undefined;
  try {
    for (let i = 0; i < 3; i++) {
      const user = await client.user.create({
        data: {
          loginName: `idem-${randomUUID()}`,
          name: 'idempotency fixture',
          passwordHash: 'test-only-no-login',
        },
      });
      ids.push(user.id);
    }
    const actors: AccessIdentity[] = [];
    for (const id of ids.slice(0, 2)) {
      scopes.push(`user:${id}`);
      const session = await client.refreshSession.create({
        data: {
          userId: id,
          tokenHash: refreshHash(newRefreshToken()),
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      actors.push({ sub: String(id), sid: String(session.id), cv: 1 });
    }
    const targetId = ids[2]!;
    const role = await client.role.create({
      data: { code: `idem-${randomUUID()}`, name: 'test action authorization' },
    });
    roleId = role.id;
    for (const actor of actors)
      await client.userRole.create({ data: { userId: BigInt(actor.sub), roleId } });
    const command = (options: Partial<IdempotentCommand> = {}): IdempotentCommand => {
      const identity = options.identity ?? actors[0]!;
      return {
        identity,
        userLocks: [{ id: String(targetId), mode: 'UPDATE' }],
        key: randomUUID(),
        requestId: randomUUID(),
        operationId: 'test.idempotent',
        entityType: 'user',
        entityId: String(targetId),
        targets: { userId: String(targetId) },
        dto: { expectedVersion: 1 },
        responseFields: ['id', 'status', 'version'],
        authorize: async (tx, phase) => {
          if (phase === 'transaction') {
            await tx.$queryRaw`SELECT id FROM users WHERE id = ${targetId} FOR UPDATE`;
            await tx.$queryRaw`SELECT id FROM roles WHERE id = ${role.id} FOR SHARE`;
          }
          const granted = await tx.userRole.findFirst({
            where: { userId: BigInt(identity.sub), roleId: role.id, role: { status: 'ACTIVE' } },
          });
          if (!granted) throw new ApiException('PERMISSION_DENIED', 'Permission denied');
        },
        execute: async (tx, dto) => {
          const user = await tx.user.findUniqueOrThrow({ where: { id: targetId } });
          const expected = (dto as { expectedVersion?: number }).expectedVersion;
          if (expected !== undefined && user.version !== expected)
            throw new ApiException('VERSION_CONFLICT', 'Version conflict');
          const changed = await tx.user.update({
            where: { id: targetId },
            data: { version: { increment: 1 } },
          });
          return {
            httpStatus: 201,
            body: {
              id: String(targetId),
              version: changed.version,
              status: 'UPDATED',
              passwordHash: 'never-store',
            },
            audit: { after: { value: { version: changed.version }, fields: ['version'] } },
          };
        },
        ...options,
      };
    };
    await work({
      client,
      database: app.get(PrismaService),
      audit: app.get(AuditService),
      service: app.get(IdempotencyService),
      store: app.get(IdempotencyStore),
      targetId,
      actors,
      command,
      roleId,
    });
  } finally {
    await app.close();
    await client.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await client.commandAttempt.deleteMany({ where: { actorId: { in: ids } } });
    await client.idempotencyRecord.deleteMany({ where: { scope: { in: scopes } } });
    await client.userRole.deleteMany({ where: { userId: { in: ids } } });
    if (roleId) await client.role.delete({ where: { id: roleId } });
    await client.refreshSession.deleteMany({ where: { userId: { in: ids } } });
    await client.user.deleteMany({ where: { id: { in: ids } } });
    await client.$disconnect();
  }
}

test('real MySQL: retry replays first result despite old expectedVersion, with one business write and one success audit', async () => {
  await fixture(async ({ client, service, command, targetId, actors }) => {
    const input = command();
    const first = await service.execute(input);
    const replay = await service.execute({
      ...input,
      requestId: randomUUID(),
      key: String(input.key).toUpperCase(),
    });
    assert.equal(first.httpStatus, 201);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
    assert.equal((await client.user.findUniqueOrThrow({ where: { id: targetId } })).version, 2);
    assert.equal(await client.auditLog.count({ where: { actorId: BigInt(actors[0]!.sub) } }), 1);
    const attempts = await client.commandAttempt.findMany({
      where: { actorId: BigInt(actors[0]!.sub) },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(
      attempts.map((item) => item.status),
      ['SUCCEEDED', 'REPLAYED'],
    );
    const stored = await client.idempotencyRecord.findUniqueOrThrow({
      where: { scope_key: { scope: `user:${actors[0]!.sub}`, key: String(input.key) } },
    });
    assert.ok(stored.completedAt);
    assert.ok(stored.expiresAt.getTime() - stored.completedAt.getTime() >= 7 * 86400000);
    assert.ok(!JSON.stringify(stored.responseBody).includes('password'));
  });
});

test('real MySQL: same key across operation, target and parameters conflicts; other users have independent scopes', async () => {
  await fixture(async ({ client, service, command, targetId, actors }) => {
    const input = command();
    await service.execute(input);
    for (const difference of [
      { operationId: 'test.other' },
      { entityId: 'another' },
      { targets: { userId: 'another' } },
      { dto: { expectedVersion: 2 } },
    ])
      await assert.rejects(
        service.execute({ ...input, ...difference, requestId: randomUUID() }),
        code('IDEMPOTENCY_KEY_REUSED'),
      );
    await service.execute(
      command({
        identity: actors[1]!,
        key: input.key,
        dto: { expectedVersion: 2 },
        userLocks: [
          { id: actors[0]!.sub, mode: 'UPDATE' },
          { id: String(targetId), mode: 'UPDATE' },
        ],
      }),
    );
    assert.equal((await client.user.findUniqueOrThrow({ where: { id: targetId } })).version, 3);
  });
});

test('real MySQL: concurrent same key yields one effect and one replay', async () => {
  await fixture(async ({ client, service, command, targetId }) => {
    const input = command();
    const results = await Promise.all([
      service.execute(input),
      service.execute({ ...input, requestId: randomUUID() }),
    ]);
    assert.deepEqual(results.map((item) => item.replayed).sort(), [false, true]);
    assert.equal((await client.user.findUniqueOrThrow({ where: { id: targetId } })).version, 2);
  });
});

test('real MySQL: pending same key waits about 2 seconds then conflicts without executing a second callback', async () => {
  await fixture(async ({ service, command }) => {
    let prepared!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = command();
    const original = input.execute;
    let calls = 0;
    const owner = service.execute({
      ...input,
      execute: async (tx, dto) => {
        calls++;
        prepared();
        await gate;
        return original(tx, dto);
      },
    });
    try {
      await Promise.race([
        ready,
        owner.then(() => {
          throw new Error('Missing signal');
        }),
      ]);
      const started = performance.now();
      await assert.rejects(
        service.execute({ ...input, requestId: randomUUID() }),
        code('IDEMPOTENCY_IN_PROGRESS'),
      );
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 1800 && elapsed < 4500, `Observed bounded contention ${elapsed} ms`);
      assert.equal(calls, 1);
    } finally {
      release();
      await owner;
    }
  });
});

test('real MySQL: business rollback leaves no key/result/audit, records FAILED and permits a same-key retry', async () => {
  await fixture(async ({ client, service, command, targetId, actors }) => {
    const input = command();
    await assert.rejects(
      service.execute({
        ...input,
        execute: async (tx, dto) => {
          await input.execute(tx, dto);
          throw new ApiException('BUSINESS_RULE_VIOLATION', 'Fixture rejection');
        },
      }),
      code('BUSINESS_RULE_VIOLATION'),
    );
    assert.equal((await client.user.findUniqueOrThrow({ where: { id: targetId } })).version, 1);
    assert.equal(
      await client.idempotencyRecord.count({ where: { scope: `user:${actors[0]!.sub}` } }),
      0,
    );
    assert.equal(await client.auditLog.count({ where: { actorId: BigInt(actors[0]!.sub) } }), 0);
    assert.equal(
      (await client.commandAttempt.findFirstOrThrow({ where: { actorId: BigInt(actors[0]!.sub) } }))
        .status,
      'FAILED',
    );
    await service.execute(input);
  });
});

test('real MySQL: replay reauthorizes and rejects revoked access; authorization is repeated inside the write transaction', async () => {
  await fixture(async ({ client, service, command, roleId, actors }) => {
    const input = command();
    await service.execute(input);
    await client.userRole.delete({
      where: { userId_roleId: { userId: BigInt(actors[0]!.sub), roleId } },
    });
    await assert.rejects(service.execute(input), code('PERMISSION_DENIED'));
    await client.userRole.create({ data: { userId: BigInt(actors[0]!.sub), roleId } });
    const fresh = command();
    const authorize = fresh.authorize;
    await assert.rejects(
      service.execute({
        ...fresh,
        authorize: async (tx, phase) => {
          await authorize(tx, phase);
          if (phase === 'preflight')
            await client.userRole.delete({
              where: { userId_roleId: { userId: BigInt(actors[0]!.sub), roleId } },
            });
        },
      }),
      code('PERMISSION_DENIED'),
    );
  });
});

test('real MySQL: lost commit acknowledgement recovers committed result using a separate client without reexecuting', async () => {
  await fixture(async ({ client, database, audit, service, command, targetId }) => {
    const original = audit.withTransaction.bind(audit);
    let inject = true;
    audit.withTransaction = async (db, work, options) => {
      const result = await original(db, work, options);
      if (db === database.client && inject) {
        inject = false;
        throw new Error('injected lost commit acknowledgement');
      }
      return result;
    };
    try {
      const result = await service.execute(command());
      assert.equal(result.replayed, true);
      assert.equal(result.httpStatus, 201);
      assert.equal((await client.user.findUniqueOrThrow({ where: { id: targetId } })).version, 2);
    } finally {
      audit.withTransaction = original;
    }
  });
});

test('real MySQL: a commit failure with confirmed rollback is not automatically reexecuted and can retry with the same key', async () => {
  await fixture(async ({ client, database, audit, service, command, targetId }) => {
    const original = audit.withTransaction.bind(audit);
    const input = command();
    audit.withTransaction = async (db, work, options) => {
      if (db !== database.client) return original(db, work, options);
      return original(
        db,
        async (tx) => {
          await work(tx);
          throw new Error('injected commit failure with rollback');
        },
        options,
      );
    };
    try {
      await assert.rejects(service.execute(input), code('SERVICE_UNAVAILABLE'));
    } finally {
      audit.withTransaction = original;
    }
    assert.equal((await client.user.findUniqueOrThrow({ where: { id: targetId } })).version, 1);
    assert.equal((await service.execute(input)).replayed, false);
  });
});

test('real MySQL: prewrite failure prevents execution; success-audit failure rolls back business and key', async () => {
  await fixture(async ({ client, audit, service, command, targetId, actors }) => {
    const input = command();
    const start = audit.startAttempt.bind(audit);
    audit.startAttempt = async () => {
      throw new ApiException('AUDIT_UNAVAILABLE', 'Injected failure');
    };
    try {
      await assert.rejects(service.execute(input), code('AUDIT_UNAVAILABLE'));
    } finally {
      audit.startAttempt = start;
    }
    assert.equal((await client.user.findUniqueOrThrow({ where: { id: targetId } })).version, 1);
    assert.equal(
      await client.commandAttempt.count({ where: { actorId: BigInt(actors[0]!.sub) } }),
      0,
    );
    const success = audit.recordSuccess.bind(audit);
    audit.recordSuccess = async () => {
      throw new ApiException('AUDIT_UNAVAILABLE', 'Injected failure');
    };
    try {
      await assert.rejects(service.execute(input), code('AUDIT_UNAVAILABLE'));
    } finally {
      audit.recordSuccess = success;
    }
    assert.equal((await client.user.findUniqueOrThrow({ where: { id: targetId } })).version, 1);
    assert.equal(
      await client.idempotencyRecord.count({ where: { scope: `user:${actors[0]!.sub}` } }),
      0,
    );
  });
});

test('real MySQL: unknown outcome remains fenced when recovery cannot probe; reconciliation never fabricates success', async () => {
  await fixture(async ({ client, database, audit, service, command, targetId, actors }) => {
    const original = audit.withTransaction.bind(audit);
    const input = command();
    audit.withTransaction = async (db, work, options) => {
      if (db !== database.client) throw new Error('injected recovery probe unavailable');
      return original(
        db,
        async (tx) => {
          await work(tx);
          throw new Error('injected rollback acknowledgement lost');
        },
        options,
      );
    };
    try {
      await assert.rejects(service.execute(input), code('IDEMPOTENCY_RESULT_UNKNOWN'));
    } finally {
      audit.withTransaction = original;
    }
    assert.equal((await client.user.findUniqueOrThrow({ where: { id: targetId } })).version, 1);
    const attempt = await client.commandAttempt.findFirstOrThrow({
      where: { actorId: BigInt(actors[0]!.sub) },
    });
    assert.equal(attempt.status, 'UNKNOWN');
    await assert.rejects(service.execute(input), code('IDEMPOTENCY_RESULT_UNKNOWN'));
    assert.equal(await client.auditLog.count({ where: { actorId: BigInt(actors[0]!.sub) } }), 0);
  });
});

test('real MySQL: expired retained results still replay; after fixture cleanup a key is new and business checks still apply', async () => {
  await fixture(async ({ client, service, command, actors, targetId }) => {
    const input = command({ dto: {} });
    await service.execute(input);
    const where = { scope: `user:${actors[0]!.sub}`, key: String(input.key) };
    await client.idempotencyRecord.update({
      where: { scope_key: where },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    assert.equal((await service.execute(input)).replayed, true);
    await client.idempotencyRecord.delete({ where: { scope_key: where } });
    assert.equal((await service.execute(input)).replayed, false);
    assert.equal((await client.user.findUniqueOrThrow({ where: { id: targetId } })).version, 3);
  });
});

test('real MySQL: oversized snapshots roll back business updates, and temporary session settings are restored', async () => {
  await fixture(async ({ client, database, service, store, command, targetId }) => {
    const input = command();
    await assert.rejects(
      service.execute({
        ...input,
        execute: async (tx, dto) => {
          const result = await input.execute(tx, dto);
          return { ...result, body: { status: '中'.repeat(22000) } };
        },
      }),
      code('SERVICE_UNAVAILABLE'),
    );
    assert.equal((await client.user.findUniqueOrThrow({ where: { id: targetId } })).version, 1);
    await database.client.$transaction(async (tx) => {
      const read = () =>
        tx.$queryRaw<
          { seconds: bigint | number }[]
        >`SELECT @@session.innodb_lock_wait_timeout AS seconds`;
      const before = Number((await read())[0]!.seconds);
      await assert.rejects(
        store.withWaitLimit(tx, async () => {
          assert.equal(Number((await read())[0]!.seconds), 2);
          throw new Error('fixture failure');
        }),
        /fixture failure/,
      );
      assert.equal(Number((await read())[0]!.seconds), before);
    });
  });
});
