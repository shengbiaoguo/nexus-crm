import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Prisma } from '../../src/generated/prisma/client.js';
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js';
import { localDatabaseUrl } from '../../src/database/local-database.js';

const client = createPrismaClient(localDatabaseUrl());
after(() => client.$disconnect());
class Rollback extends Error {}
const uniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
const fkViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
async function fixture(work: (tx: Prisma.TransactionClient, userId: bigint) => Promise<void>) {
  await assert.rejects(
    client.$transaction(
      async (tx) => {
        const user = await tx.user.create({
          data: {
            loginName: `crm-${randomUUID()}`,
            name: 'CRM fixture',
            passwordHash: 'unused',
          },
        });
        await work(tx, user.id);
        throw new Rollback();
      },
      { timeout: 20000 },
    ),
    Rollback,
  );
}
const customerData = (userId: bigint) => ({
  name: 'Same name allowed',
  normalizedName: 'SAME NAME ALLOWED',
  ownerId: userId,
  createdBy: userId,
});

test('CRM physical columns, exact FK targets, indexes, generated key and migration checksum match reviewed SQL', async () => {
  const tableNames = [
    'customers',
    'customer_members',
    'customer_contacts',
    'opportunities',
    'follow_ups',
  ];
  const fks = await client.$queryRaw<
    Array<{ table_name: string; column_name: string; target_table: string; target_column: string }>
  >`
    SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, REFERENCED_TABLE_NAME AS target_table,
      REFERENCED_COLUMN_NAME AS target_column FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`;
  assert.deepEqual(
    fks
      .filter((row) => tableNames.includes(row.table_name))
      .map(
        (row) => `${row.table_name}.${row.column_name}->${row.target_table}.${row.target_column}`,
      )
      .sort(),
    [
      'customer_contacts.created_by->users.id',
      'customer_contacts.customer_id->customers.id',
      'customer_members.customer_id->customers.id',
      'customer_members.user_id->users.id',
      'customers.created_by->users.id',
      'customers.owner_id->users.id',
      'follow_ups.author_id->users.id',
      'follow_ups.correction_of_id->follow_ups.id',
      'follow_ups.opportunity_id->opportunities.id',
      'opportunities.created_by->users.id',
      'opportunities.customer_id->customers.id',
      'opportunities.owner_id->users.id',
    ],
  );
  for (const fk of fks.filter((row) => tableNames.includes(row.table_name))) {
    for (const identifier of [fk.table_name, fk.column_name, fk.target_table, fk.target_column]) {
      assert.match(identifier, /^[a-z_]+$/);
    }
    const orphans = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM \`${fk.table_name}\` c LEFT JOIN \`${fk.target_table}\` p
        ON c.\`${fk.column_name}\` = p.\`${fk.target_column}\`
        WHERE c.\`${fk.column_name}\` IS NOT NULL AND p.\`${fk.target_column}\` IS NULL`,
    );
    assert.equal(BigInt(orphans[0]?.count ?? -1), 0n);
  }
  const columns = await client.$queryRaw<
    Array<{
      table_name: string;
      name: string;
      type: string;
      nullable: string;
      extra: string;
      expression: string;
    }>
  >`
    SELECT TABLE_NAME AS table_name, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
      EXTRA AS extra, GENERATION_EXPRESSION AS expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()`;
  const expected: Record<string, string[]> = {
    customers: [
      'id',
      'name',
      'normalized_name',
      'credit_code',
      'owner_id',
      'status',
      'description',
      'version',
      'created_by',
      'created_at',
      'updated_at',
    ],
    customer_members: ['customer_id', 'user_id', 'created_at'],
    customer_contacts: [
      'id',
      'customer_id',
      'name',
      'title',
      'phone',
      'phone_normalized',
      'email',
      'email_normalized',
      'status',
      'is_primary',
      'primary_customer_id',
      'version',
      'created_by',
      'created_at',
      'updated_at',
    ],
    opportunities: [
      'id',
      'customer_id',
      'owner_id',
      'title',
      'description',
      'stage',
      'closed_at',
      'close_reason',
      'version',
      'created_by',
      'created_at',
      'updated_at',
    ],
    follow_ups: [
      'id',
      'opportunity_id',
      'author_id',
      'content',
      'next_follow_up_at',
      'correction_of_id',
      'created_at',
    ],
  };
  for (const table of tableNames) {
    const actual = columns.filter((row) => row.table_name === table);
    assert.deepEqual(actual.map((row) => row.name).sort(), expected[table]?.toSorted());
    for (const row of actual) {
      if (row.name === 'id' || row.name.endsWith('_id') || row.name === 'created_by')
        assert.equal(row.type, 'bigint unsigned');
      if (row.name.endsWith('_at')) assert.equal(row.type, 'datetime(3)');
      if (row.name === 'version') assert.equal(row.type, 'int unsigned');
    }
  }
  const generated = columns.find(
    (row) => row.table_name === 'customer_contacts' && row.name === 'primary_customer_id',
  );
  assert.equal(generated?.extra, 'STORED GENERATED');
  assert.match(generated?.expression ?? '', /case when.*is_primary.*customer_id.*else NULL end/i);
  assert.equal(
    columns.find((row) => row.table_name === 'customers' && row.name === 'credit_code')?.nullable,
    'YES',
  );
  const indexes = await client.$queryRaw<
    Array<{ table_name: string; name: string; non_unique: bigint; columns: string }>
  >`
    SELECT TABLE_NAME AS table_name, INDEX_NAME AS name, NON_UNIQUE AS non_unique,
      GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`;
  for (const [table, name, fields, unique] of [
    ['customers', 'customers_credit_code_key', 'credit_code', true],
    ['customers', 'customers_owner_status_time_idx', 'owner_id,status,created_at,id', false],
    ['customers', 'customers_normalized_name_idx', 'normalized_name', false],
    ['customer_members', 'PRIMARY', 'customer_id,user_id', true],
    ['customer_members', 'customer_members_user_customer_idx', 'user_id,customer_id', false],
    ['customer_contacts', 'customer_contacts_primary_customer_key', 'primary_customer_id', true],
    [
      'customer_contacts',
      'customer_contacts_customer_time_idx',
      'customer_id,created_at,id',
      false,
    ],
    ['customer_contacts', 'customer_contacts_phone_idx', 'phone_normalized', false],
    ['customer_contacts', 'customer_contacts_email_idx', 'email_normalized', false],
    [
      'opportunities',
      'opportunities_customer_stage_time_idx',
      'customer_id,stage,created_at,id',
      false,
    ],
    ['opportunities', 'opportunities_owner_stage_idx', 'owner_id,stage', false],
    ['follow_ups', 'follow_ups_opportunity_time_idx', 'opportunity_id,created_at,id', false],
    ['follow_ups', 'follow_ups_author_idx', 'author_id', false],
    ['follow_ups', 'follow_ups_correction_idx', 'correction_of_id', false],
  ] as const) {
    const index = indexes.find((row) => row.table_name === table && row.name === name);
    assert.equal(index?.columns, fields);
    assert.equal(Number(index?.non_unique), unique ? 0 : 1);
  }
  const sql = await readFile('prisma/migrations/20261030090155_m1_crm/migration.sql');
  const migration = await client.$queryRaw<Array<{ checksum: string; finished_at: Date | null }>>`
    SELECT checksum, finished_at FROM _prisma_migrations WHERE migration_name='20261030090155_m1_crm'`;
  assert.equal(migration[0]?.checksum, createHash('sha256').update(sql).digest('hex'));
  assert.ok(migration[0]?.finished_at);
});

test('CRM credit codes are globally unique including archived customers; NULLs and duplicate names coexist', async () => {
  await fixture(async (tx, userId) => {
    await tx.customer.create({ data: customerData(userId) });
    await tx.customer.create({ data: customerData(userId) });
    const code = randomUUID().replaceAll('-', '').slice(0, 18).toUpperCase();
    await tx.customer.create({
      data: { ...customerData(userId), creditCode: code, status: 'ARCHIVED' },
    });
    await assert.rejects(
      tx.customer.create({ data: { ...customerData(userId), creditCode: code } }),
      uniqueViolation,
    );
    await assert.rejects(tx.customer.create({ data: { ...customerData(userId), creditCode: '' } }));
    await assert.rejects(
      tx.customer.create({ data: { ...customerData(userId), creditCode: code.toLowerCase() } }),
    );
  });
});

test('generated primary contact key is omitted by Prisma writes, allows ordinary contacts, and protects concurrent primary inserts', async () => {
  const user = await client.user.create({
    data: { loginName: `crm-${randomUUID()}`, name: 'fixture', passwordHash: 'unused' },
  });
  let customerId: bigint | undefined;
  try {
    const customer = await client.customer.create({ data: customerData(user.id) });
    customerId = customer.id;
    const data = {
      customerId,
      createdBy: user.id,
      name: 'contact',
      phone: '123456',
      phoneNormalized: '123456',
    };
    await client.customerContact.create({ data });
    await client.customerContact.create({ data });
    const results = await Promise.allSettled([
      client.customerContact.create({ data: { ...data, isPrimary: true } }),
      client.customerContact.create({ data: { ...data, isPrimary: true } }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const failure = results.find((result) => result.status === 'rejected');
    assert.ok(failure?.status === 'rejected' && uniqueViolation(failure.reason));
    const primary = await client.customerContact.findFirstOrThrow({
      where: { customerId, isPrimary: true },
    });
    assert.equal('primaryCustomerId' in primary, false);
    await assert.rejects(
      client.customerContact.update({ where: { id: primary.id }, data: { status: 'INACTIVE' } }),
    );
    await client.customerContact.update({
      where: { id: primary.id },
      data: { isPrimary: false, status: 'INACTIVE' },
    });
    await client.customerContact.create({ data: { ...data, isPrimary: true } });
    await assert.rejects(
      client.customerContact.create({
        data: { customerId, createdBy: user.id, name: 'unreachable' },
      }),
    );
  } finally {
    if (customerId !== undefined) {
      await client.customerContact.deleteMany({ where: { customerId } });
      await client.customer.delete({ where: { id: customerId } });
    }
    await client.user.delete({ where: { id: user.id } });
  }
});

test('concurrent credit-code inserts have exactly one committed result', async () => {
  const user = await client.user.create({
    data: { loginName: `crm-${randomUUID()}`, name: 'fixture', passwordHash: 'unused' },
  });
  const creditCode = randomUUID().replaceAll('-', '').slice(0, 18).toUpperCase();
  try {
    const data = { ...customerData(user.id), creditCode };
    const results = await Promise.allSettled([
      client.customer.create({ data }),
      client.customer.create({ data }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const failure = results.find((result) => result.status === 'rejected');
    assert.ok(failure?.status === 'rejected' && uniqueViolation(failure.reason));
    assert.equal(await client.customer.count({ where: { creditCode } }), 1);
  } finally {
    await client.customer.deleteMany({ where: { ownerId: user.id } });
    await client.user.delete({ where: { id: user.id } });
  }
});

test('CRM FKs reject orphans, preserve disabled historical users and audit, and corrections retain original follow-up', async () => {
  await fixture(async (tx, userId) => {
    const customer = await tx.customer.create({ data: customerData(userId) });
    await tx.customerMember.create({ data: { customerId: customer.id, userId } });
    await assert.rejects(
      tx.customerMember.create({ data: { customerId: customer.id, userId } }),
      uniqueViolation,
    );
    const contact = await tx.customerContact.create({
      data: {
        customerId: customer.id,
        createdBy: userId,
        name: 'fixture',
        email: 'fixture@example.invalid',
      },
    });
    const opportunity = await tx.opportunity.create({
      data: { customerId: customer.id, ownerId: userId, createdBy: userId, title: 'fixture' },
    });
    await assert.rejects(
      tx.opportunity.update({ where: { id: opportunity.id }, data: { stage: 'WON' } }),
    );
    await tx.opportunity.update({
      where: { id: opportunity.id },
      data: { stage: 'LOST', closedAt: new Date(), closeReason: 'fixture' },
    });
    const original = await tx.followUp.create({
      data: { opportunityId: opportunity.id, authorId: userId, content: 'original' },
    });
    const correction = await tx.followUp.create({
      data: {
        opportunityId: opportunity.id,
        authorId: userId,
        content: 'correction',
        correctionOfId: original.id,
      },
    });
    assert.equal(correction.correctionOfId, original.id);
    assert.equal(
      (await tx.followUp.findUniqueOrThrow({ where: { id: original.id } })).content,
      'original',
    );
    const audit = await tx.auditLog.create({
      data: {
        actorId: userId,
        action: 'fixture',
        entityType: 'customer',
        entityId: customer.id.toString(),
        requestId: randomUUID(),
      },
    });
    await tx.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
    assert.equal(
      (await tx.auditLog.findUniqueOrThrow({ where: { id: audit.id } })).actorId,
      userId,
    );
    await assert.rejects(tx.user.delete({ where: { id: userId } }), fkViolation);
    await assert.rejects(tx.customer.delete({ where: { id: customer.id } }), fkViolation);
    await assert.rejects(tx.opportunity.delete({ where: { id: opportunity.id } }), fkViolation);
    await assert.rejects(tx.followUp.delete({ where: { id: original.id } }), fkViolation);
    const missing = 18446744073709551615n;
    await assert.rejects(
      tx.customer.create({ data: { ...customerData(userId), ownerId: missing } }),
      fkViolation,
    );
    await assert.rejects(
      tx.customer.create({ data: { ...customerData(userId), createdBy: missing } }),
      fkViolation,
    );
    await assert.rejects(
      tx.customerMember.create({ data: { customerId: missing, userId } }),
      fkViolation,
    );
    await assert.rejects(
      tx.customerMember.create({ data: { customerId: customer.id, userId: missing } }),
      fkViolation,
    );
    await assert.rejects(
      tx.customerContact.update({ where: { id: contact.id }, data: { customerId: missing } }),
      fkViolation,
    );
    await assert.rejects(
      tx.customerContact.update({ where: { id: contact.id }, data: { createdBy: missing } }),
      fkViolation,
    );
    for (const data of [{ customerId: missing }, { ownerId: missing }, { createdBy: missing }]) {
      await assert.rejects(
        tx.opportunity.update({ where: { id: opportunity.id }, data }),
        fkViolation,
      );
    }
    for (const data of [
      { opportunityId: missing },
      { authorId: missing },
      { correctionOfId: missing },
    ]) {
      await assert.rejects(tx.followUp.update({ where: { id: correction.id }, data }), fkViolation);
    }
  });
});
