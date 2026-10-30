import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { localDatabaseUrl } from '../apps/api/dist/database/local-database.js';
import { createPrismaClient } from '../apps/api/dist/infrastructure/prisma-client.js';

const client = createPrismaClient(localDatabaseUrl());
const target = 'utf8mb4_0900_ai_ci';
const models = [
  'user',
  'department',
  'role',
  'permission',
  'userRole',
  'rolePermission',
  'refreshSession',
  'auditLog',
  'idempotencyRecord',
  'commandAttempt',
];
const tables = [
  'users',
  'departments',
  'roles',
  'permissions',
  'user_roles',
  'role_permissions',
  'refresh_sessions',
  'audit_logs',
  'idempotency_records',
  'command_attempts',
];
const directory = new URL('../artifacts/', import.meta.url);
const snapshotFile = new URL('before-m0-collation.json', directory);
const stringify = (value) =>
  JSON.stringify(
    value,
    (_, item) => (typeof item === 'bigint' ? { bigint: item.toString() } : item),
    2,
  );
const identifier = (value) => {
  assert.match(value, /^[a-z_]+$/);
  return `\`${value}\``;
};
try {
  const database =
    await client.$queryRaw`SELECT DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()`;
  assert.equal(
    database[0]?.collation,
    target,
    'database default must match the explicit migration target',
  );
  const schemaTables =
    await client.$queryRaw`SELECT TABLE_NAME AS name, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`;
  assert.deepEqual(
    schemaTables
      .filter((row) => row.name !== '_prisma_migrations')
      .map((row) => row.name)
      .sort(),
    [...tables].sort(),
  );
  const columns =
    await client.$queryRaw`SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLLATION_NAME IS NOT NULL`;
  const indexes =
    await client.$queryRaw`SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, COLUMN_NAME AS column_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND NON_UNIQUE=0 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;
  const groups = new Map();
  for (const index of indexes.filter((index) => tables.includes(index.table_name))) {
    const key = `${index.table_name}.${index.index_name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }
  for (const index of groups.values()) {
    if (
      !index.some((item) =>
        columns.some(
          (column) =>
            column.table_name === item.table_name && column.column_name === item.column_name,
        ),
      )
    )
      continue;
    const expressions = index.map(
      (item) =>
        identifier(item.column_name) +
        (columns.some(
          (column) =>
            column.table_name === item.table_name && column.column_name === item.column_name,
        )
          ? ` COLLATE ${target}`
          : ''),
    );
    const notNull = index
      .map((item) => `${identifier(item.column_name)} IS NOT NULL`)
      .join(' AND ');
    const conflicts = await client.$queryRawUnsafe(
      `SELECT COUNT(*) AS conflicts FROM (SELECT 1 FROM ${identifier(index[0].table_name)} WHERE ${notNull} GROUP BY ${expressions.join(', ')} HAVING COUNT(*) > 1) AS collisions`,
    );
    assert.equal(
      Number(conflicts[0].conflicts),
      0,
      `target collation uniqueness conflict: ${index[0].index_name}`,
    );
  }
  const data = {};
  for (const model of models) {
    data[model] = await client[model].findMany({
      orderBy:
        model === 'userRole'
          ? [{ userId: 'asc' }, { roleId: 'asc' }]
          : model === 'rolePermission'
            ? [{ roleId: 'asc' }, { permissionId: 'asc' }]
            : { id: 'asc' },
    });
  }
  if (process.argv.includes('--verify')) {
    const before = JSON.parse(await readFile(snapshotFile, 'utf8'));
    assert.ok(
      stringify(data) === stringify(before.data),
      'application rows changed during conversion',
    );
    assert.ok(
      schemaTables
        .filter((row) => tables.includes(row.name))
        .every((row) => row.collation === target),
    );
    assert.ok(
      columns
        .filter((row) => tables.includes(row.table_name))
        .every((row) => row.collation === target),
    );
    const metadata = schemaTables.find((row) => row.name === '_prisma_migrations');
    assert.equal(
      metadata?.collation,
      before.metadataCollation,
      'Prisma metadata collation must remain unchanged',
    );
    console.log(
      'PASS: 10 application tables and all character columns use target collation; all application rows unchanged; metadata unchanged.',
    );
  } else {
    const definitions = {};
    for (const table of tables)
      definitions[table] = await client.$queryRawUnsafe(`SHOW CREATE TABLE ${identifier(table)}`);
    await mkdir(directory, { recursive: true });
    // Local recovery evidence may contain sensitive rows; artifacts/ is ignored by Git. Never print it.
    await writeFile(
      snapshotFile,
      stringify({
        data,
        definitions,
        metadataCollation: schemaTables.find((row) => row.name === '_prisma_migrations')?.collation,
      }) + '\n',
      { flag: 'wx' },
    );
    console.log(
      'PASS: database default verified; no target-collation unique collisions; local pre-migration data/DDL snapshot saved under ignored artifacts/.',
    );
    console.log(
      JSON.stringify(schemaTables.map((row) => ({ table: row.name, collation: row.collation }))),
    );
  }
} finally {
  await client.$disconnect();
}
