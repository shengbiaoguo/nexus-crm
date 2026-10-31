import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  isBusinessRole,
  requireBusinessGrant,
} from '../src/authorization/identity-write.policy.js';
import { createValidationPipe } from '../src/http/validation.pipe.js';
import { AssignRolesDto, IdentityCommandDto } from '../src/authorization/identity-write.dto.js';
import { ApiException } from '../src/http/api.exception.js';

test('identity writes classify business capabilities by action and scope, not role names', () => {
  assert.equal(isBusinessRole([{ code: 'role:manage', scopeCode: 'IDENTITY' }]), false);
  assert.equal(isBusinessRole([{ code: 'department:read', scopeCode: 'AUTHENTICATED' }]), false);
  for (const grant of [
    { code: 'role:grant_business', scopeCode: 'IDENTITY' },
    { code: 'customer:read', scopeCode: 'IDENTITY' },
    { code: 'audit:read', scopeCode: 'ALL' },
    { code: 'role:manage', scopeCode: 'TEAM' },
  ])
    assert.equal(isBusinessRole([grant]), true);
  const grant = { roleId: '7', code: 'role:grant_business', scopeCode: 'IDENTITY' };
  requireBusinessGrant([grant], 7n, 1n, 2n);
  for (const [grants, actor, target] of [
    [[grant], 1n, 1n],
    [[{ ...grant, roleId: '8' }], 1n, 2n],
    [[{ ...grant, scopeCode: 'ALL' }], 1n, 2n],
    [[], 1n, 2n],
  ] as const)
    assert.throws(
      () => requireBusinessGrant(grants, 7n, actor, target),
      (error: unknown) => error instanceof ApiException && error.code === 'PERMISSION_DENIED',
    );
});

test('identity command DTOs reject coercion, missing/null/duplicate/invalid IDs and unknown protected fields', async () => {
  const pipe = createValidationPipe();
  const valid = {
    expectedVersion: 1,
    reason: ' deliberate change ',
    roleIds: ['9007199254740993'],
  };
  const parsed = (await pipe.transform(valid, {
    type: 'body',
    metatype: AssignRolesDto,
  })) as AssignRolesDto;
  assert.equal(parsed.reason, 'deliberate change');
  assert.deepEqual(parsed.roleIds, valid.roleIds);
  for (const change of [
    { expectedVersion: '1' },
    { expectedVersion: 0 },
    { expectedVersion: 4294967295 },
    { reason: null },
    { reason: ' ' },
    { roleIds: null },
    { roleIds: '1' },
    { roleIds: [1] },
    { roleIds: ['01'] },
    { roleIds: ['18446744073709551616'] },
    { roleIds: ['1', '1'] },
    { roleIds: Array.from({ length: 101 }, (_, index) => String(index + 1)) },
    { status: 'DISABLED' },
    { credentialVersion: 2 },
    { password: 'not-accepted' },
  ])
    await assert.rejects(
      pipe.transform({ ...valid, ...change }, { type: 'body', metatype: AssignRolesDto }),
    );
  await assert.rejects(
    pipe.transform(
      { expectedVersion: 1, reason: 'fixture', roleIds: [] },
      { type: 'body', metatype: IdentityCommandDto },
    ),
  );
});

test('explicit unassigned-user CLI rejects embedded grants and never prints its secret input', () => {
  const password = 'fixture-password-must-never-appear';
  const result = spawnSync(
    process.execPath,
    ['dist-test/src/database/bootstrap-identity.js', '--create-unassigned-user'],
    {
      input: JSON.stringify({
        loginName: 'not-created',
        name: 'fixture',
        password,
        roleIds: ['1'],
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.ok(!(result.stdout + result.stderr).includes(password));
  assert.ok(!result.stdout.includes('initialized'));
});
