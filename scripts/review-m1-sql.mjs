import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const sql = await readFile(
  new URL('../apps/api/prisma/migrations/20261030090155_m1_crm/migration.sql', import.meta.url),
  'utf8',
);
const tables = [
  'customer_contacts',
  'customer_members',
  'customers',
  'follow_ups',
  'opportunities',
];
assert.deepEqual([...sql.matchAll(/CREATE TABLE `([a-z_]+)`/g)].map((m) => m[1]).sort(), tables);
assert.doesNotMatch(sql, /^\s*(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\s/im);
assert.doesNotMatch(sql, /expected_amount|ON DELETE CASCADE|ON UPDATE CASCADE/i);
for (const match of sql.matchAll(/ALTER TABLE `([a-z_]+)`/g)) assert.ok(tables.includes(match[1]));
assert.equal(
  [...sql.matchAll(/DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;/g)].length,
  5,
);
assert.equal([...sql.matchAll(/FOREIGN KEY/g)].length, 12);
assert.equal([...sql.matchAll(/ON DELETE RESTRICT ON UPDATE RESTRICT/g)].length, 12);
assert.equal([...sql.matchAll(/ADD CONSTRAINT `[a-z_]+_check`/g)].length, 4);
assert.match(
  sql,
  /`primary_customer_id` BIGINT UNSIGNED GENERATED ALWAYS AS \(CASE WHEN `is_primary` = 1 THEN `customer_id` ELSE NULL END\) STORED/,
);
assert.match(sql, /UNIQUE INDEX `customer_contacts_primary_customer_key`\(`primary_customer_id`\)/);
assert.match(sql, /UNIQUE INDEX `customers_credit_code_key`\(`credit_code`\)/);
assert.doesNotMatch(
  sql,
  /UNIQUE INDEX[^\n]+\(`name`\)|UNIQUE INDEX[^\n]+\(`customer_id`, `is_primary`\)/,
);
console.log(
  'PASS M1 SQL review: 5 additive tables, 12 RESTRICT FKs, 4 CHECKs, generated primary-contact uniqueness, explicit collation; no M0 ALTER',
);
