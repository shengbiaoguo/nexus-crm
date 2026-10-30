import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(
  new URL('../apps/api/prisma/migrations/20261030014538_init_m0/migration.sql', import.meta.url),
  'utf8',
);
const tables = [...sql.matchAll(/CREATE TABLE `([a-z_]+)`/g)].map((match) => match[1]).sort();
assert.deepEqual(tables, [
  'audit_logs',
  'command_attempts',
  'departments',
  'idempotency_records',
  'permissions',
  'refresh_sessions',
  'role_permissions',
  'roles',
  'user_roles',
  'users',
]);
assert.doesNotMatch(sql, /^\s*(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\s/im);
assert.doesNotMatch(sql, /ON DELETE CASCADE|ON UPDATE CASCADE/i);
const counts = {
  tables: tables.length,
  primaryKeys: [...sql.matchAll(/PRIMARY KEY/g)].length,
  uniqueIndexes: [...sql.matchAll(/UNIQUE INDEX/g)].length,
  ordinaryIndexes: [...sql.matchAll(/^ {4}INDEX/gm)].length,
  foreignKeys: [...sql.matchAll(/FOREIGN KEY/g)].length,
  restrictedForeignKeys: [...sql.matchAll(/ON DELETE RESTRICT ON UPDATE RESTRICT/g)].length,
  actorChecks: [...sql.matchAll(/ {4}CHECK/g)].length,
};
assert.equal(counts.foreignKeys, 10);
assert.equal(counts.restrictedForeignKeys, 10);
assert.equal(counts.actorChecks, 2);
console.log('PASS M0 SQL structural review', JSON.stringify(counts));
