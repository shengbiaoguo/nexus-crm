import assert from 'node:assert/strict';
import { test } from 'node:test';
import { salesScopes, visibleSalesRoot } from '../src/authorization/sales.policy.js';
import { bootstrapInput } from '../src/database/bootstrap-identity.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { WriteLockService } from '../src/authorization/write-lock.service.js';
import { StructuredLogger } from '../src/logging/structured-logger.service.js';
import { createPrismaClient } from '../src/infrastructure/prisma-client.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('sales grants pair action/scope, reject implicit admin/project access and separate collaboration from approval', () => {
  const grant = (code: string, scopeCode: string) => ({ roleId: '1', code, scopeCode });
  for (const action of ['*', 'toString', 'delivery:start', 'payment:confirm'])
    assert.deepEqual(salesScopes([grant(action, 'ALL')], action), []);
  assert.deepEqual(
    salesScopes([grant('customer:read', 'IDENTITY'), grant('role:manage', 'ALL')], 'customer:read'),
    [],
  );
  assert.deepEqual(salesScopes([grant('customer:read', 'ASSIGNED_PROJECT')], 'customer:read'), []);
  assert.deepEqual(salesScopes([grant('order:approve', 'SELF_COLLABORATOR')], 'order:approve'), []);
  assert.deepEqual(
    salesScopes([grant('customer:assign', 'SELF_COLLABORATOR')], 'customer:assign'),
    [],
  );
  assert.deepEqual(salesScopes([grant('product:read', 'ALL')], 'product:read'), []);
  assert.deepEqual(salesScopes([grant('product:read', 'CATALOG')], 'product:read'), ['CATALOG']);
  const root = { ownerId: 9007199254740993n, collaboratorIds: [2n] };
  assert.equal(visibleSalesRoot(['SELF_COLLABORATOR'], 9007199254740993n, root, false), true);
  assert.equal(visibleSalesRoot(['SELF_COLLABORATOR'], 2n, root, false), true);
  assert.equal(visibleSalesRoot(['SELF_COLLABORATOR'], 3n, root, false), false);
  assert.equal(visibleSalesRoot(['TEAM'], 2n, root, false), false);
  assert.equal(visibleSalesRoot(['ALL'], 3n, root, false), true);
});

test('bootstrap input rejects default/short passwords, unknown grant controls and null without implicit coercion', () => {
  const input = {
    loginName: ' operator ',
    name: ' Operator ',
    password: '  a sufficiently long password  ',
  };
  const parsed = bootstrapInput.parse(input);
  assert.equal(parsed.loginName, 'operator');
  assert.equal(parsed.password, input.password);
  for (const bad of [
    { ...input, password: 'admin' },
    { ...input, roleCode: 'system_admin' },
    { ...input, password: null },
    { ...input, password: ' '.repeat(20) },
    { ...input, name: '' },
    { ...input, loginName: 123 },
  ])
    assert.equal(bootstrapInput.safeParse(bad).success, false);
});

test('operational CLIs reject missing bootstrap consent or malformed cursors without printing secret stdin', () => {
  for (const [file, args] of [
    ['../src/database/bootstrap-identity.js', []],
    ['../src/audit/reconcile-attempts.js', ['--after-id=-1']],
  ] as const) {
    const secret = 'sensitive-fixture-input-do-not-print';
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(file, import.meta.url)), ...args],
      { input: secret, encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    assert.doesNotMatch(result.stderr, /PrismaClient|mysql:\/\//);
  }
});

test('write locks reject a root client instead of pretending statement locks protect a transaction', async () => {
  const audit = new AuditService(new StructuredLogger());
  const service = new WriteLockService(audit);
  const root = createPrismaClient('mysql://unused:unused@127.0.0.1:1/unused');
  // Registry rejects this before any connection is created.
  await assert.rejects(
    service.acquire(
      root,
      { sub: '1', sid: '1', cv: 1 },
      { users: [{ id: '1', mode: 'SHARE' }], roles: [], departments: [] },
    ),
    /registered/,
  );
});
