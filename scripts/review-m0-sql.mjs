import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

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

const directory = new URL('../apps/api/prisma/migrations/', import.meta.url);
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === '20261030014538_init_m0') continue;
  const migration = await readFile(new URL(`${entry.name}/migration.sql`, directory), 'utf8');
  const declarations = [
    ...migration.matchAll(
      /CREATE TABLE `[a-z_]+` \([\s\S]*?\) DEFAULT CHARACTER SET ([a-z0-9_]+) COLLATE ([a-z0-9_]+);/g,
    ),
  ];
  assert.equal(
    declarations.length,
    [...migration.matchAll(/CREATE TABLE /g)].length,
    'new tables must declare charset and collation explicitly',
  );
  for (const declaration of declarations) {
    assert.equal(declaration[1], 'utf8mb4');
    assert.equal(declaration[2], 'utf8mb4_0900_ai_ci');
  }
}
const alignment = await readFile(
  new URL('20261030020831_align_m0_collation/migration.sql', directory),
  'utf8',
);
assert.equal(
  [...alignment.matchAll(/CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;/g)].length,
  10,
);
assert.doesNotMatch(alignment, /ALTER TABLE `_prisma_migrations`|FOREIGN_KEY_CHECKS/i);
assert.equal([...alignment.matchAll(/DROP FOREIGN KEY/g)].length, 1);
assert.equal([...alignment.matchAll(/ADD CONSTRAINT/g)].length, 1);
console.log('PASS explicit collation policy and 10-table alignment SQL review');
