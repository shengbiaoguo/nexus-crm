import { mkdir, writeFile } from 'node:fs/promises';
import { createPrismaClient } from '../infrastructure/prisma-client.js';
import { localDatabaseUrl } from './local-database.js';

const client = createPrismaClient(localDatabaseUrl());
try {
  const tables = await client.$queryRaw<
    Array<{ table_name: string }>
  >`SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`;
  const columns =
    await client.$queryRaw`SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`;
  const indexes =
    await client.$queryRaw`SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name, SEQ_IN_INDEX AS position FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;
  const foreignKeys =
    await client.$queryRaw`SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS constraint_name, DELETE_RULE AS delete_rule, UPDATE_RULE AS update_rule FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() ORDER BY TABLE_NAME, CONSTRAINT_NAME`;
  const checks =
    await client.$queryRaw`SELECT CONSTRAINT_NAME AS constraint_name, CHECK_CLAUSE AS check_clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()`;
  const counts = {
    users: await client.user.count(),
    departments: await client.department.count(),
    roles: await client.role.count(),
    permissions: await client.permission.count(),
    userRoles: await client.userRole.count(),
    rolePermissions: await client.rolePermission.count(),
    refreshSessions: await client.refreshSession.count(),
    auditLogs: await client.auditLog.count(),
    idempotencyRecords: await client.idempotencyRecord.count(),
    commandAttempts: await client.commandAttempt.count(),
  };
  const directory = new URL('../../../../artifacts/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL('m0-database-verification.json', directory),
    JSON.stringify(
      { tables, columns, indexes, foreignKeys, checks, counts },
      (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ) + '\n',
  );
  console.log(
    'PASS M0 live database inspection; details saved to artifacts/m0-database-verification.json',
  );
  console.log(JSON.stringify({ tables: tables.length, counts }));
} finally {
  await client.$disconnect();
}
