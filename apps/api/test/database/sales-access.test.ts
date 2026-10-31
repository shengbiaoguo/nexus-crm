import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApplication } from '../../src/application.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { localDatabaseUrl } from '../../src/database/local-database.js';
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js';
import { PrismaService } from '../../src/infrastructure/prisma.service.js';
import { SalesAuthorizationService } from '../../src/authorization/sales-authorization.service.js';
import { SalesAccessService } from '../../src/authorization/sales-access.service.js';
import { SalesWriteService } from '../../src/authorization/sales-write.service.js';
import type { SalesWritePlan } from '../../src/authorization/sales-write.service.js';
import type { CrmTarget } from '../../src/authorization/crm-target.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { IdempotencyService } from '../../src/idempotency/idempotency.service.js';
import { IdempotencyStore } from '../../src/idempotency/idempotency.store.js';
import { ApiException } from '../../src/http/api.exception.js';
import { newRefreshToken, refreshHash } from '../../src/auth/auth.crypto.js';
import type { AccessIdentity } from '../../src/auth/auth.crypto.js';
import type { ScopeCode } from '../../src/generated/prisma/enums.js';
import type { Prisma } from '../../src/generated/prisma/client.js';

const code = (expected: string) => (error: unknown) =>
  error instanceof ApiException && error.code === expected;
const page = { page: 1, pageSize: 100 };
type Client = ReturnType<typeof createPrismaClient>;
type App = Awaited<ReturnType<typeof createApplication>>['app'];
interface Context {
  client: Client;
  app: App;
  users: bigint[];
  departments: bigint[];
  identities: AccessIdentity[];
  customers: bigint[];
  opportunities: bigint[];
  contacts: bigint[];
  followUps: bigint[];
  extraContact: bigint;
  extraFollowUp: bigint;
  access: SalesAccessService;
  writes: SalesWriteService;
  audit: AuditService;
  grant: (action: string, scope: ScopeCode, actor?: number) => Promise<bigint>;
  change: (
    customer: number,
    key?: string,
    actor?: number,
  ) => Promise<Awaited<ReturnType<IdempotencyService['execute']>>>;
}
async function fixture(work: (context: Context) => Promise<void>) {
  const client = createPrismaClient(localDatabaseUrl());
  const { app, document } = await createApplication(
    { ...loadEnvironment(), AUTH_JWT_SECRET: randomBytes(32).toString('base64url') },
    false,
  );
  const users: bigint[] = [],
    roles: bigint[] = [],
    permissions: bigint[] = [],
    departments: bigint[] = [];
  const customers: bigint[] = [],
    opportunities: bigint[] = [],
    contacts: bigint[] = [],
    followUps: bigint[] = [];
  try {
    for (const parent of [null, 0, 1, null] as const) {
      const row = await client.department.create({
        data: {
          name: `t05-${randomUUID()}`,
          parentId: parent === null ? null : departments[parent]!,
        },
      });
      departments.push(row.id);
    }
    for (const department of [1, 2, 3, 0, 1] as const) {
      const row = await client.user.create({
        data: {
          loginName: `t05-${randomUUID()}`,
          name: 'T05 fixture',
          passwordHash: 'no-login',
          departmentId: departments[department]!,
        },
      });
      users.push(row.id);
    }
    const identities: AccessIdentity[] = [];
    for (const id of users) {
      const row = await client.refreshSession.create({
        data: {
          userId: id,
          tokenHash: refreshHash(newRefreshToken()),
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      identities.push({ sub: String(id), sid: String(row.id), cv: 1 });
    }
    for (const owner of [0, 2, 1, 2, 3, 4]) {
      const row = await client.customer.create({
        data: {
          ownerId: users[owner]!,
          createdBy: users[0]!,
          name: `t05-${randomUUID()}`,
          normalizedName: 'T05',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      customers.push(row.id);
      const opportunity = await client.opportunity.create({
        data: { customerId: row.id, ownerId: users[0]!, createdBy: users[0]!, title: 'T05' },
      });
      opportunities.push(opportunity.id);
      const contact = await client.customerContact.create({
        data: { customerId: row.id, createdBy: users[0]!, name: 'T05', phone: '123456' },
      });
      contacts.push(contact.id);
      const follow = await client.followUp.create({
        data: {
          opportunityId: opportunity.id,
          authorId: users[0]!,
          content: 'fixture private content',
        },
      });
      followUps.push(follow.id);
    }
    await client.customerMember.create({ data: { customerId: customers[1]!, userId: users[0]! } });
    const extraContact = await client.customerContact.create({
      data: {
        customerId: customers[0]!,
        createdBy: users[0]!,
        name: 'second',
        email: 'fixture@example.invalid',
      },
    });
    const extraFollowUp = await client.followUp.create({
      data: { opportunityId: opportunities[0]!, authorId: users[0]!, content: 'second' },
    });
    const grant = async (action: string, scope: ScopeCode, actor = 0) => {
      let permission = await client.permission.findUnique({ where: { code: action } });
      if (!permission) {
        permission = await client.permission.create({
          data: { code: action, description: 'T05 fixture' },
        });
        permissions.push(permission.id);
      }
      const role = await client.role.create({
        data: { code: `t05-${randomUUID()}`, name: 'system_admin' },
      });
      roles.push(role.id);
      await client.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id, scopeCode: scope },
      });
      await client.userRole.create({ data: { userId: users[actor]!, roleId: role.id } });
      return role.id;
    };
    await app.init();
    assert.ok(!document.paths['/api/v1/customers']);
    assert.ok(!document.paths['/api/v1/opportunities']);
    const access = app.get(SalesAccessService),
      writes = app.get(SalesWriteService),
      audit = app.get(AuditService);
    const change: Context['change'] = async (index, key = randomUUID(), actor = 0) => {
      const identity = identities[actor]!;
      const target: CrmTarget = { kind: 'customer', id: customers[index]! };
      const plan = await writes.plan(identity, 'customer:update', [target]);
      return app.get(IdempotencyService).execute({
        identity,
        key,
        requestId: randomUUID(),
        operationId: 'test.salesAccess',
        entityType: 'customer',
        entityId: String(target.id),
        targets: { customerId: String(target.id) },
        dto: { expectedVersion: 1 },
        responseFields: ['id', 'status', 'version'],
        userLocks: plan.identity.users,
        authorize: (tx, phase) =>
          phase === 'preflight'
            ? writes.requireTargets(tx, identity, 'customer:update', [target])
            : writes.acquire(tx, identity, plan).then(() => undefined),
        execute: async (tx) => {
          const row = await tx.customer.findUniqueOrThrow({ where: { id: target.id } });
          if (row.version !== 1) throw new ApiException('VERSION_CONFLICT', 'fixture');
          const updated = await tx.customer.update({
            where: { id: target.id },
            data: { description: 'T05 committed fixture', version: { increment: 1 } },
          });
          return {
            httpStatus: 200,
            body: { id: String(updated.id), status: updated.status, version: updated.version },
          };
        },
      });
    };
    await work({
      client,
      app,
      users,
      departments,
      identities,
      customers,
      opportunities,
      contacts,
      followUps,
      extraContact: extraContact.id,
      extraFollowUp: extraFollowUp.id,
      access,
      writes,
      audit,
      grant,
      change,
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
        await client.followUp.deleteMany({ where: { opportunityId: { in: opportunities } } });
        await client.opportunity.deleteMany({ where: { id: { in: opportunities } } });
        await client.customerContact.deleteMany({ where: { customerId: { in: customers } } });
        await client.customerMember.deleteMany({ where: { customerId: { in: customers } } });
        await client.customer.deleteMany({ where: { id: { in: customers } } });
        await client.userRole.deleteMany({ where: { userId: { in: users } } });
        await client.rolePermission.deleteMany({ where: { roleId: { in: roles } } });
        await client.role.deleteMany({ where: { id: { in: roles } } });
        await client.permission.deleteMany({ where: { id: { in: permissions } } });
        await client.refreshSession.deleteMany({ where: { userId: { in: users } } });
        await client.user.deleteMany({ where: { id: { in: users } } });
        // Tests may reparent these random fixture nodes; sever only their own
        // links before deletion, retaining every real FK and historical row.
        await client.department.updateMany({
          where: { id: { in: departments } },
          data: { parentId: null },
        });
        await client.department.deleteMany({ where: { id: { in: departments } } });
      } finally {
        await client.$disconnect();
      }
    }
  }
}

test('T05 real CRM: SELF/COLLABORATOR SQL list/count/details agree; historical creator and opportunity owner confer no access', async () => {
  await fixture(
    async ({ grant, access, identities, customers, opportunities, contacts, followUps }) => {
      const identity = identities[0]!;
      await assert.rejects(access.customers(identity, page), code('PERMISSION_DENIED'));
      await grant('customer:read', 'SELF_COLLABORATOR');
      await grant('opportunity:read', 'SELF_COLLABORATOR');
      const list = await access.customers(identity, page);
      assert.deepEqual(
        list.data.map(({ id }) => id),
        [customers[1], customers[0]],
      );
      assert.equal(list.total, 2);
      assert.equal(
        (await access.customers(identity, { page: 2, pageSize: 1 })).data[0]?.id,
        customers[0],
      );
      assert.equal((await access.customer(identity, customers[1]!)).id, customers[1]);
      for (const index of [2, 3, 4, 5])
        await assert.rejects(
          access.customer(identity, customers[index]!),
          code('RESOURCE_NOT_FOUND'),
        );
      const children = await access.opportunities(identity, page);
      assert.equal(children.total, 2);
      assert.ok(
        children.data.every(({ customerId }) => [customers[0], customers[1]].includes(customerId)),
      );
      await assert.rejects(
        access.opportunity(identity, opportunities[3]!),
        code('RESOURCE_NOT_FOUND'),
      );
      await assert.rejects(
        access.contact(identity, customers[0]!, contacts[1]!),
        code('RESOURCE_NOT_FOUND'),
      );
      await assert.rejects(
        access.followUp(identity, opportunities[0]!, followUps[1]!),
        code('RESOURCE_NOT_FOUND'),
      );
      assert.deepEqual(
        Object.keys(await access.contact(identity, customers[0]!, contacts[0]!)).sort(),
        ['customerId', 'id', 'status', 'version'],
      );
      assert.deepEqual(
        Object.keys(await access.followUp(identity, opportunities[0]!, followUps[0]!)).sort(),
        ['createdAt', 'id', 'opportunityId'],
      );
    },
  );
});

test('T05 real CRM: TEAM includes peers/descendants, excludes ancestors/outside; unions never splice scope from another action', async () => {
  await fixture(async ({ client, grant, access, identities, customers, users, departments }) => {
    await grant('customer:read', 'TEAM');
    await grant('customer:update', 'ALL');
    const expected = [customers[5], customers[2], customers[0]];
    assert.deepEqual(
      (await access.customers(identities[0]!, page)).data.map(({ id }) => id),
      expected,
    );
    await client.user.update({ where: { id: users[1]! }, data: { departmentId: null } });
    assert.equal((await access.customers(identities[0]!, page)).total, 2);
    await client.user.update({ where: { id: users[1]! }, data: { departmentId: departments[2]! } });
    await grant('customer:read', 'SELF_COLLABORATOR');
    assert.equal((await access.customers(identities[0]!, page)).total, 4);
    await grant('customer:read', 'ALL');
    assert.equal(
      (await access.customers(identities[0]!, page)).total,
      await client.customer.count(),
    );
  });
});

test('T05 real CRM: invalid scopes, role names, unsupported finance/project/catalog objects and absent actions fail closed', async () => {
  await fixture(async ({ app, client, grant, access, writes, identities, customers }) => {
    const identity = identities[0]!;
    for (const scope of ['FINANCE_RELATED', 'ASSIGNED_PROJECT', 'CATALOG', 'IDENTITY'] as const)
      await grant('customer:read', scope);
    await grant('customer:update', 'ALL');
    await assert.rejects(access.customers(identity, page), code('PERMISSION_DENIED'));
    const sales = app.get(SalesAuthorizationService);
    await grant('customer:assign', 'SELF_COLLABORATOR');
    await assert.rejects(
      writes.plan(identity, 'customer:assign', [{ kind: 'customer', id: customers[0]! }]),
      code('PERMISSION_DENIED'),
    );
    await grant('product:read', 'CATALOG');
    await grant('customer:read', 'ALL');
    await assert.rejects(
      writes.plan(identity, 'customer:read', [{ kind: 'customer', id: customers[0]! }]),
      code('PERMISSION_DENIED'),
    );
    await client.$transaction((tx) => sales.requireCreationOrCatalog(tx, identity, 'product:read'));
    await assert.rejects(
      client.$transaction((tx) => sales.requireCreationOrCatalog(tx, identity, 'product:manage')),
      code('PERMISSION_DENIED'),
    );
    await assert.rejects(
      writes.plan(identity, 'product:read', [{ kind: 'customer', id: customers[0]! }]),
      code('PERMISSION_DENIED'),
    );
    await assert.rejects(
      writes.plan(identity, 'unknown', [{ kind: 'customer', id: customers[0]! }]),
      code('PERMISSION_DENIED'),
    );
  });
});

test('T05 real CRM: null department and disabled ancestors remove TEAM even when the immediate actor department is active', async () => {
  await fixture(async ({ client, grant, access, identities, users, departments }) => {
    await grant('customer:read', 'TEAM');
    await client.department.update({
      where: { id: departments[0]! },
      data: { status: 'DISABLED' },
    });
    assert.equal((await access.customers(identities[0]!, page)).total, 0);
    await client.department.update({ where: { id: departments[0]! }, data: { status: 'ACTIVE' } });
    await client.user.update({ where: { id: users[0]! }, data: { departmentId: null } });
    assert.equal((await access.customers(identities[0]!, page)).total, 0);
    await client.user.update({ where: { id: users[0]! }, data: { departmentId: departments[1]! } });
    await client.department.update({
      where: { id: departments[0]! },
      data: { parentId: departments[2]! },
    });
    try {
      await assert.rejects(access.customers(identities[0]!, page), code('SERVICE_UNAVAILABLE'));
    } finally {
      await client.department.update({ where: { id: departments[0]! }, data: { parentId: null } });
    }
    await client.user.update({ where: { id: users[0]! }, data: { status: 'DISABLED' } });
    await assert.rejects(access.customers(identities[0]!, page), code('UNAUTHENTICATED'));
  });
});

test('T05 real CRM: list and total use one SQL predicate and one snapshot despite a committed owner change between them', async () => {
  await fixture(async ({ app, client, grant, access, identities, customers, users }) => {
    await grant('customer:read', 'SELF_COLLABORATOR');
    const database = app.get(PrismaService);
    const root = database.client;
    const where: unknown[] = [];
    let switched = false;
    const extended = root.$extends({
      query: {
        customer: {
          async findMany({ args, query }) {
            where.push(args.where);
            const rows = await query(args);
            if (!switched) {
              switched = true;
              await client.customer.update({
                where: { id: customers[0]! },
                data: { ownerId: users[2]! },
              });
            }
            return rows;
          },
          async count({ args, query }) {
            where.push(args.where);
            return query(args);
          },
        },
      },
    });
    Object.defineProperty(database, 'client', { get: () => extended });
    const before = await access.customers(identities[0]!, page);
    assert.equal(before.total, 2);
    assert.equal(before.data.length, 2);
    assert.deepEqual(where[0], where[1]);
    const after = await access.customers(identities[0]!, page);
    assert.equal(after.total, 1);
    assert.equal(after.data[0]?.id, customers[1]);
  });
});

test('T05 real CRM: role scope replacement/revocation and session invalidation affect fresh reads using the same identity', async () => {
  await fixture(async ({ client, access, identities, grant, users }) => {
    const roleId = await grant('customer:read', 'ALL');
    assert.ok((await access.customers(identities[0]!, page)).total >= 6);
    await client.rolePermission.updateMany({
      where: { roleId },
      data: { scopeCode: 'SELF_COLLABORATOR' },
    });
    assert.equal((await access.customers(identities[0]!, page)).total, 2);
    await client.userRole.delete({ where: { userId_roleId: { userId: users[0]!, roleId } } });
    await assert.rejects(access.customers(identities[0]!, page), code('PERMISSION_DENIED'));
    await client.refreshSession.update({
      where: { id: BigInt(identities[0]!.sid) },
      data: { revokedAt: new Date() },
    });
    await assert.rejects(access.customers(identities[0]!, page), code('UNAUTHENTICATED'));
  });
});

test('T05 real CRM: write plans reject mismatched parent chains, cross-customer targets and root/unregistered/wrong-isolation clients', async () => {
  await fixture(
    async ({
      app,
      client,
      grant,
      writes,
      audit,
      identities,
      customers,
      opportunities,
      contacts,
      followUps,
    }) => {
      await grant('customer:update', 'SELF_COLLABORATOR');
      const identity = identities[0]!;
      await assert.rejects(
        writes.plan(identity, 'customer:update', [
          { kind: 'contact', id: contacts[1]!, customerId: customers[0]! },
        ]),
        code('RESOURCE_NOT_FOUND'),
      );
      await assert.rejects(
        writes.plan(identity, 'customer:update', [
          { kind: 'followUp', id: followUps[1]!, opportunityId: opportunities[0]! },
        ]),
        code('RESOURCE_NOT_FOUND'),
      );
      await assert.rejects(
        writes.plan(identity, 'customer:update', [
          { kind: 'customer', id: customers[0]! },
          { kind: 'customer', id: customers[1]! },
        ]),
        code('RESOURCE_NOT_FOUND'),
      );
      await assert.rejects(
        writes.plan(identity, 'customer:update', [{ kind: 'opportunity', id: opportunities[3]! }]),
        code('RESOURCE_NOT_FOUND'),
      );
      const plan = await writes.plan(identity, 'customer:update', [
        { kind: 'customer', id: customers[0]! },
      ]);
      await assert.rejects(
        writes.acquire(client as unknown as Prisma.TransactionClient, identity, plan),
        /registered/,
      );
      await assert.rejects(
        client.$transaction((tx) => writes.acquire(tx, identity, plan)),
        /registered/,
      );
      await assert.rejects(
        audit.withTransaction(
          app.get(PrismaService).client,
          (tx) => writes.acquire(tx, identity, plan),
          { isolationLevel: 'RepeatableRead' },
        ),
        /ReadCommitted/,
      );
      await assert.rejects(
        audit.withTransaction(
          app.get(PrismaService).client,
          (tx) => writes.acquire(tx, identity, { ...plan }),
          { isolationLevel: 'ReadCommitted' },
        ),
        /server-owned/,
      );
      const moved = await writes.plan(identity, 'customer:update', [
        { kind: 'opportunity', id: opportunities[0]! },
      ]);
      await client.opportunity.update({
        where: { id: opportunities[0]! },
        data: { customerId: customers[3]! },
      });
      await assert.rejects(
        audit.withTransaction(
          app.get(PrismaService).client,
          (tx) => writes.acquire(tx, identity, moved),
          { isolationLevel: 'ReadCommitted' },
        ),
        code('RESOURCE_NOT_FOUND'),
      );
    },
  );
});

test('T05 real CRM: creation eligibility is independent of reading and is rechecked after identity locks', async () => {
  await fixture(async ({ app, client, grant, writes, access, audit, identities, users }) => {
    await assert.rejects(writes.planCreation(identities[0]!), code('PERMISSION_DENIED'));
    const roleId = await grant('customer:create', 'SELF_COLLABORATOR');
    const plan = await writes.planCreation(identities[0]!);
    const id = await audit.withTransaction(
      app.get(PrismaService).client,
      (tx) => writes.acquireCreation(tx, identities[0]!, plan),
      { isolationLevel: 'ReadCommitted' },
    );
    assert.equal(id, users[0]);
    await assert.rejects(access.customers(identities[0]!, page), code('PERMISSION_DENIED'));
    await client.rolePermission.updateMany({ where: { roleId }, data: { scopeCode: 'IDENTITY' } });
    await assert.rejects(
      audit.withTransaction(
        app.get(PrismaService).client,
        (tx) => writes.acquireCreation(tx, identities[0]!, plan),
        { isolationLevel: 'ReadCommitted' },
      ),
      code('PERMISSION_DENIED'),
    );
  });
});

test('T05 real CRM: stale plans reject changed owner, collaborator, user department, department ancestry and role membership', async () => {
  await fixture(
    async ({ app, client, grant, writes, audit, identities, customers, users, departments }) => {
      await grant('customer:update', 'ALL');
      const acquire = (plan: SalesWritePlan) =>
        audit.withTransaction(
          app.get(PrismaService).client,
          (tx) => writes.acquire(tx, identities[0]!, plan),
          { isolationLevel: 'ReadCommitted' },
        );
      let plan = await writes.plan(identities[0]!, 'customer:update', [
        { kind: 'customer', id: customers[0]! },
      ]);
      await client.customer.update({ where: { id: customers[0]! }, data: { ownerId: users[2]! } });
      await assert.rejects(acquire(plan), code('VERSION_CONFLICT'));
      plan = await writes.plan(identities[0]!, 'customer:update', [
        { kind: 'customer', id: customers[1]! },
      ]);
      await client.customerMember.deleteMany({ where: { customerId: customers[1]! } });
      await assert.rejects(acquire(plan), code('VERSION_CONFLICT'));
      plan = await writes.plan(identities[0]!, 'customer:update', [
        { kind: 'customer', id: customers[2]! },
      ]);
      await client.user.update({
        where: { id: users[1]! },
        data: { departmentId: departments[3]! },
      });
      await assert.rejects(acquire(plan), code('VERSION_CONFLICT'));
      plan = await writes.plan(identities[0]!, 'customer:update', [
        { kind: 'customer', id: customers[2]! },
      ]);
      await client.department.update({
        where: { id: departments[2]! },
        data: { parentId: departments[3]! },
      });
      await assert.rejects(acquire(plan), code('VERSION_CONFLICT'));
      plan = await writes.plan(identities[0]!, 'customer:update', [
        { kind: 'customer', id: customers[2]! },
      ]);
      await grant('opportunity:read', 'ALL');
      await assert.rejects(acquire(plan), code('VERSION_CONFLICT'));
    },
  );
});

test('T05 real CRM: current customer ownership and collaboration govern writes and replay, not the original author', async () => {
  await fixture(async ({ client, grant, change, identities, access, customers, users }) => {
    await grant('customer:update', 'SELF_COLLABORATOR');
    await grant('customer:read', 'SELF_COLLABORATOR');
    const key = randomUUID();
    const first = await change(0, key);
    assert.equal(first.body?.version, 2);
    assert.equal((await change(0, key)).replayed, true);
    assert.equal(
      await client.auditLog.count({ where: { actorId: users[0]!, action: 'test.salesAccess' } }),
      1,
    );
    await client.customer.update({ where: { id: customers[0]! }, data: { ownerId: users[2]! } });
    await assert.rejects(change(0, key), code('RESOURCE_NOT_FOUND'));
    await assert.rejects(
      access.customer(identities[0]!, customers[0]!),
      code('RESOURCE_NOT_FOUND'),
    );
    await client.customerMember.deleteMany({ where: { customerId: customers[1]! } });
    await assert.rejects(change(1), code('RESOURCE_NOT_FOUND'));
    assert.equal(
      (await client.customer.findUniqueOrThrow({ where: { id: customers[0]! } })).version,
      2,
    );
  });
});

test('T05 real CRM: revoked scope denies new writes and completed-key replay; success audit fault rolls back the actual CRM update', async () => {
  await fixture(
    async ({ client, grant, change, app, audit, customers, users, identities, writes }) => {
      const roleId = await grant('customer:update', 'SELF_COLLABORATOR');
      const key = randomUUID();
      await change(0, key);
      await client.rolePermission.updateMany({
        where: { roleId },
        data: { scopeCode: 'IDENTITY' },
      });
      await assert.rejects(change(0, key), code('PERMISSION_DENIED'));
      await assert.rejects(change(1), code('PERMISSION_DENIED'));
      await client.rolePermission.updateMany({
        where: { roleId },
        data: { scopeCode: 'SELF_COLLABORATOR' },
      });
      const original = audit.recordSuccess;
      audit.recordSuccess = async () => {
        throw new ApiException('AUDIT_UNAVAILABLE', 'fixture');
      };
      try {
        await assert.rejects(change(1), code('AUDIT_UNAVAILABLE'));
      } finally {
        audit.recordSuccess = original;
      }
      assert.equal(
        (await client.customer.findUniqueOrThrow({ where: { id: customers[1]! } })).version,
        1,
      );
      assert.equal(
        await client.idempotencyRecord.count({ where: { scope: `user:${users[0]}` } }),
        1,
      );
      const plan = await writes.plan(identities[0]!, 'customer:update', [
        { kind: 'customer', id: customers[1]! },
      ]);
      await client.rolePermission.updateMany({
        where: { roleId },
        data: { scopeCode: 'IDENTITY' },
      });
      await assert.rejects(
        audit.withTransaction(
          app.get(PrismaService).client,
          (tx) => writes.acquire(tx, identities[0]!, plan),
          { isolationLevel: 'ReadCommitted' },
        ),
        code('PERMISSION_DENIED'),
      );
    },
  );
});

test('T05 real CRM: in-flight write serializes a properly locked ownership change, which then removes the old owner access', async () => {
  await fixture(
    async ({ app, client, grant, writes, audit, identities, customers, users, access }) => {
      await grant('customer:update', 'SELF_COLLABORATOR');
      await grant('customer:read', 'SELF_COLLABORATOR');
      await grant('customer:update', 'ALL', 4);
      const target: CrmTarget = { kind: 'customer', id: customers[0]! };
      const old = await writes.plan(identities[0]!, 'customer:update', [target]);
      const next = await writes.plan(
        identities[4]!,
        'customer:update',
        [target],
        [{ id: String(users[2]), mode: 'SHARE' }],
      );
      let ready!: () => void, release!: () => void;
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = audit.withTransaction(
        app.get(PrismaService).client,
        async (tx) => {
          await writes.acquire(tx, identities[0]!, old);
          ready();
          await gate;
          await tx.customer.update({
            where: { id: target.id },
            data: { description: 'committed before ownership change' },
          });
        },
        { isolationLevel: 'ReadCommitted', timeout: 15000 },
      );
      try {
        await Promise.race([
          held,
          writer.then(() => {
            throw new Error('Writer did not signal');
          }),
        ]);
        await assert.rejects(
          audit.withTransaction(
            client,
            (tx) =>
              new IdempotencyStore().withWaitLimit(tx, () =>
                writes.acquire(tx, identities[4]!, next),
              ),
            { isolationLevel: 'ReadCommitted', timeout: 5000 },
          ),
          /lock wait timeout/i,
        );
        release();
        await writer;
        await audit.withTransaction(
          client,
          async (tx) => {
            await writes.acquire(tx, identities[4]!, next);
            await tx.customer.update({ where: { id: target.id }, data: { ownerId: users[2]! } });
          },
          { isolationLevel: 'ReadCommitted' },
        );
        await assert.rejects(
          access.customer(identities[0]!, target.id),
          code('RESOURCE_NOT_FOUND'),
        );
        assert.equal(
          (await client.customer.findUniqueOrThrow({ where: { id: target.id } })).description,
          'committed before ownership change',
        );
      } finally {
        release();
        await writer;
      }
    },
  );
});

test('T05 real CRM: locked authorization prevents in-flight member, role, department and user-department revocation', async () => {
  await fixture(
    async ({ app, client, grant, writes, audit, identities, customers, users, departments }) => {
      const roleId = await grant('customer:update', 'TEAM');
      const target: CrmTarget = { kind: 'customer', id: customers[2]! };
      const plan = await writes.plan(identities[0]!, 'customer:update', [target]);
      let ready!: () => void, release!: () => void;
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = audit.withTransaction(
        app.get(PrismaService).client,
        async (tx) => {
          await writes.acquire(tx, identities[0]!, plan);
          ready();
          await gate;
        },
        { isolationLevel: 'ReadCommitted', timeout: 20000 },
      );
      try {
        await Promise.race([
          held,
          holder.then(() => {
            throw new Error('No lock signal');
          }),
        ]);
        for (const work of [
          async (tx: Prisma.TransactionClient) => {
            await tx.$queryRaw`SELECT id FROM users WHERE id=${users[0]!} FOR UPDATE`;
            await tx.userRole.deleteMany({ where: { userId: users[0]!, roleId } });
          },
          async (tx: Prisma.TransactionClient) => {
            await tx.$queryRaw`SELECT id FROM roles WHERE id=${roleId} FOR UPDATE`;
            await tx.rolePermission.updateMany({
              where: { roleId },
              data: { scopeCode: 'IDENTITY' },
            });
          },
          async (tx: Prisma.TransactionClient) => {
            await tx.$queryRaw`SELECT id FROM departments WHERE id=${departments[2]!} FOR UPDATE`;
            await tx.department.update({
              where: { id: departments[2]! },
              data: { parentId: departments[3]! },
            });
          },
          async (tx: Prisma.TransactionClient) => {
            await tx.$queryRaw`SELECT id FROM users WHERE id=${users[1]!} FOR UPDATE`;
            await tx.user.update({
              where: { id: users[1]! },
              data: { departmentId: departments[3]! },
            });
          },
        ])
          await assert.rejects(
            client.$transaction((tx) => new IdempotencyStore().withWaitLimit(tx, () => work(tx)), {
              timeout: 5000,
            }),
            /lock wait timeout/i,
          );
      } finally {
        release();
        await holder;
      }
    },
  );
});

test('T05 real CRM: collaboration removal waits for the customer writer and then removes current access', async () => {
  await fixture(
    async ({ app, client, grant, writes, audit, identities, customers, users, access }) => {
      await grant('customer:update', 'SELF_COLLABORATOR');
      await grant('customer:read', 'SELF_COLLABORATOR');
      await grant('customer:update', 'ALL', 4);
      const target: CrmTarget = { kind: 'customer', id: customers[1]! };
      const member = await writes.plan(identities[0]!, 'customer:update', [target]);
      const remover = await writes.plan(identities[4]!, 'customer:update', [target]);
      let ready!: () => void, release!: () => void;
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = audit.withTransaction(
        app.get(PrismaService).client,
        async (tx) => {
          await writes.acquire(tx, identities[0]!, member);
          ready();
          await gate;
        },
        { isolationLevel: 'ReadCommitted', timeout: 15000 },
      );
      try {
        await Promise.race([
          held,
          holder.then(() => {
            throw new Error('No customer lock signal');
          }),
        ]);
        await assert.rejects(
          audit.withTransaction(
            client,
            (tx) =>
              new IdempotencyStore().withWaitLimit(tx, () =>
                writes.acquire(tx, identities[4]!, remover),
              ),
            { isolationLevel: 'ReadCommitted', timeout: 5000 },
          ),
          /lock wait timeout/i,
        );
        release();
        await holder;
        await audit.withTransaction(
          client,
          async (tx) => {
            await writes.acquire(tx, identities[4]!, remover);
            await tx.customerMember.delete({
              where: { customerId_userId: { customerId: target.id, userId: users[0]! } },
            });
          },
          { isolationLevel: 'ReadCommitted' },
        );
        await assert.rejects(
          access.customer(identities[0]!, target.id),
          code('RESOURCE_NOT_FOUND'),
        );
      } finally {
        release();
        await holder;
      }
    },
  );
});

test('T05 real CRM: reversed child inputs still acquire Opportunity then Contact then FollowUp, each in numeric order', async () => {
  await fixture(
    async ({
      app,
      client,
      grant,
      writes,
      audit,
      identities,
      opportunities,
      customers,
      contacts,
      followUps,
      extraContact,
      extraFollowUp,
    }) => {
      await grant('customer:update', 'SELF_COLLABORATOR');
      const targets: CrmTarget[] = [
        { kind: 'followUp', id: extraFollowUp, opportunityId: opportunities[0]! },
        { kind: 'contact', id: extraContact, customerId: customers[0]! },
        { kind: 'followUp', id: followUps[0]!, opportunityId: opportunities[0]! },
        { kind: 'contact', id: contacts[0]!, customerId: customers[0]! },
      ];
      const plan = await writes.plan(identities[0]!, 'customer:update', targets);
      const reverse = await writes.plan(identities[0]!, 'customer:update', [...targets].reverse());
      assert.deepEqual(plan.contacts, [contacts[0], extraContact]);
      assert.deepEqual(plan.followUps, [followUps[0], extraFollowUp]);
      assert.equal(plan.lineage, reverse.lineage);
      let contactReady!: () => void, release!: () => void, reachedContact!: () => void;
      const contactHeld = new Promise<void>((resolve) => {
        contactReady = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const contactReached = new Promise<void>((resolve) => {
        reachedContact = resolve;
      });
      const trace: string[] = [];
      const database = app.get(PrismaService);
      const base = database.client;
      const extended = base.$extends({
        query: {
          async $queryRaw({ args, query }) {
            const sql = JSON.stringify(args, (_, value: unknown) =>
              typeof value === 'bigint' ? value.toString() : value,
            );
            trace.push(sql);
            if (sql.includes('FROM customer_contacts')) reachedContact();
            return query(args);
          },
        },
      });
      Object.defineProperty(database, 'client', { get: () => extended });
      const blocker = client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM customer_contacts WHERE id=${contacts[0]!} FOR UPDATE`;
          contactReady();
          await gate;
        },
        { timeout: 15000 },
      );
      let writer: Promise<unknown> | undefined;
      try {
        await contactHeld;
        writer = audit.withTransaction(
          database.client,
          (tx) => writes.acquire(tx, identities[0]!, plan),
          { isolationLevel: 'ReadCommitted', timeout: 15000 },
        );
        await Promise.race([
          contactReached,
          writer.then(() => {
            throw new Error('Missing contact lock');
          }),
        ]);
        await assert.rejects(
          client.$transaction(
            (tx) =>
              new IdempotencyStore().withWaitLimit(
                tx,
                () =>
                  tx.$queryRaw`SELECT id FROM opportunities WHERE id=${opportunities[0]!} FOR UPDATE`,
              ),
            { timeout: 5000 },
          ),
          /lock wait timeout/i,
        );
        release();
        await blocker;
        await writer;
        const opportunity = trace.findIndex((sql) => sql.includes('FROM opportunities'));
        const contact = trace.findIndex((sql) => sql.includes('FROM customer_contacts'));
        const follow = trace.findIndex((sql) => sql.includes('FROM follow_ups'));
        assert.ok(opportunity >= 0 && opportunity < contact && contact < follow);
        await audit.withTransaction(
          database.client,
          (tx) => writes.acquire(tx, identities[0]!, reverse),
          { isolationLevel: 'ReadCommitted' },
        );
      } finally {
        release();
        await blocker;
        await writer;
      }
    },
  );
});
