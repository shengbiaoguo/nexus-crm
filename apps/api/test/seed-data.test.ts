import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { permissionCodes, roleDefinitions } from '../src/database/seed-data.js';

test('seed dictionary covers the documented capabilities and has no duplicate grants', async () => {
  const document = await readFile('../../docs/permission-matrix.md', 'utf8');
  const dictionarySection = document.split('## 2. 权限粒度')[1]?.split('## 3.')[0];
  assert.ok(dictionarySection, 'documented permission dictionary must exist');
  const expected = new Set<string>();
  for (const match of dictionarySection.matchAll(/[a-z]+:[a-z_]+(?:\/[a-z_]+)*/g)) {
    const [resource, actions] = match[0].split(':');
    for (const action of actions!.split('/')) expected.add(`${resource}:${action}`);
  }
  assert.deepEqual(permissionCodes, [...expected].sort());
  for (const role of roleDefinitions) {
    assert.equal(new Set(role.grants.map((grant) => grant.code)).size, role.grants.length);
    assert.ok(role.grants.every((grant) => expected.has(grant.code)));
  }
});

test('default administrator cannot gain business powers through seed templates', () => {
  const admin = roleDefinitions.find((role) => role.code === 'system_admin')!;
  assert.deepEqual(admin.grants.map((grant) => grant.code).sort(), [
    'audit:read',
    'department:read',
    'role:manage',
    'user:manage',
  ]);
  assert.equal(admin.grants.find((grant) => grant.code === 'audit:read')?.scopeCode, 'IDENTITY');
  const grantors = roleDefinitions.filter((role) =>
    role.grants.some((grant) => grant.code === 'role:grant_business'),
  );
  assert.deepEqual(
    grantors.map((role) => role.code),
    ['business_owner'],
  );
});
