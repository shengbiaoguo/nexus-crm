import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  salesScopes,
  teamDepartmentIds,
  visibleSalesRoot,
} from '../src/authorization/sales.policy.js';
import { ApiException } from '../src/http/api.exception.js';

test('TEAM requires a complete active ancestor chain; siblings and ancestors do not become descendants', () => {
  const departments = [
    { id: 1n, parentId: null, status: 'ACTIVE' },
    { id: 2n, parentId: 1n, status: 'ACTIVE' },
    { id: 3n, parentId: 2n, status: 'ACTIVE' },
    { id: 4n, parentId: 1n, status: 'ACTIVE' },
  ];
  assert.deepEqual(teamDepartmentIds(2n, departments), [2n, 3n]);
  assert.deepEqual(teamDepartmentIds(null, departments), []);
  assert.deepEqual(
    teamDepartmentIds(
      2n,
      departments.map((row) => (row.id === 1n ? { ...row, status: 'DISABLED' } : row)),
    ),
    [],
  );
  assert.deepEqual(
    teamDepartmentIds(
      2n,
      departments.filter(({ id }) => id !== 1n),
    ),
    [],
  );
  assert.throws(
    () =>
      teamDepartmentIds(
        2n,
        departments.map((row) => (row.id === 1n ? { ...row, parentId: 3n } : row)),
      ),
    (error: unknown) => error instanceof ApiException && error.code === 'SERVICE_UNAVAILABLE',
  );
});

test('sales grants form a union of valid action/scope pairs; collaboration never supplies assignment or approval', () => {
  const grants = [
    { roleId: '1', code: 'customer:read', scopeCode: 'SELF_COLLABORATOR' },
    { roleId: '2', code: 'customer:read', scopeCode: 'TEAM' },
    { roleId: '3', code: 'customer:update', scopeCode: 'ALL' },
    { roleId: '4', code: 'customer:read', scopeCode: 'FINANCE_RELATED' },
  ];
  assert.deepEqual(salesScopes(grants, 'customer:read'), ['SELF_COLLABORATOR', 'TEAM']);
  assert.deepEqual(salesScopes(grants, 'unknown'), []);
  assert.deepEqual(
    salesScopes(
      [{ roleId: 'sales_manager', code: 'order:approve', scopeCode: 'SELF_COLLABORATOR' }],
      'order:approve',
    ),
    [],
  );
  assert.deepEqual(
    salesScopes([{ roleId: '1', code: 'product:read', scopeCode: 'TEAM' }], 'product:read'),
    [],
  );
  assert.deepEqual(
    salesScopes([{ roleId: '1', code: 'product:read', scopeCode: 'CATALOG' }], 'product:read'),
    ['CATALOG'],
  );
  assert.deepEqual(
    salesScopes([{ roleId: '1', code: 'product:read', scopeCode: 'CATALOG' }], 'product:manage'),
    [],
  );
  assert.equal(
    visibleSalesRoot(['SELF_COLLABORATOR'], 1n, { ownerId: 9n, collaboratorIds: [1n] }, false),
    true,
  );
  assert.equal(
    visibleSalesRoot(['TEAM'], 1n, { ownerId: 9n, collaboratorIds: [1n] }, false),
    false,
  );
});
