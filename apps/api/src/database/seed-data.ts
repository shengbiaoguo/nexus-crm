import type { ScopeCode } from '../generated/prisma/enums.js';

// Data only, transcribed from permission-matrix.md §8. Not an authorization evaluator.
const dictionary = {
  customer: 'create read update assign',
  opportunity: 'create read update',
  quote: 'read create submit record_acceptance',
  order:
    'read create update submit withdraw approve reject request_cancel approve_cancel request_terminate approve_terminate request_change approve_change complete',
  delivery: 'read assign start task_manage task_update accept',
  payment: 'read record confirm reverse',
  refund: 'read create approve settle',
  product: 'read manage',
  department: 'read',
  user: 'manage',
  role: 'manage grant_business',
  audit: 'read',
};
export const permissionCodes = Object.entries(dictionary)
  .flatMap(([resource, actions]) => actions.split(' ').map((action) => `${resource}:${action}`))
  .sort();

type Grant = { code: string; scopeCode: ScopeCode };
type RoleDefinition = { code: string; name: string; grants: Grant[] };
function grants(scopeCode: ScopeCode, codes: string): Grant[] {
  return codes.split(' ').map((code) => ({ code, scopeCode }));
}
const sales =
  'customer:create customer:read customer:update opportunity:create opportunity:read opportunity:update quote:read quote:create quote:submit quote:record_acceptance order:read order:create order:update order:submit order:withdraw order:request_cancel order:request_terminate order:request_change delivery:read';
const manager =
  'customer:assign order:approve order:reject order:approve_cancel order:approve_change';
const employee = grants('AUTHENTICATED', 'department:read');
export const roleDefinitions: RoleDefinition[] = [
  {
    code: 'system_admin',
    name: '系统管理员',
    grants: [...employee, ...grants('IDENTITY', 'user:manage role:manage audit:read')],
  },
  {
    code: 'sales',
    name: '销售',
    grants: [
      ...employee,
      ...grants('SELF_COLLABORATOR', sales),
      ...grants('CATALOG', 'product:read'),
    ],
  },
  {
    code: 'sales_manager',
    name: '销售经理',
    grants: [
      ...employee,
      ...grants('TEAM', `${sales} ${manager}`),
      ...grants('CATALOG', 'product:read'),
    ],
  },
  {
    code: 'delivery_member',
    name: '交付成员',
    grants: [
      ...employee,
      ...grants('ASSIGNED_PROJECT', 'customer:read order:read delivery:read delivery:task_update'),
    ],
  },
  {
    code: 'delivery_manager',
    name: '交付经理',
    grants: [
      ...employee,
      ...grants(
        'ASSIGNED_PROJECT',
        'customer:read order:read delivery:read delivery:start delivery:task_manage delivery:task_update delivery:accept order:complete order:request_cancel order:request_terminate',
      ),
      ...grants('CATALOG', 'product:read'),
    ],
  },
  {
    code: 'finance',
    name: '财务',
    grants: [
      ...employee,
      ...grants(
        'FINANCE_RELATED',
        'customer:read order:read payment:read payment:record payment:confirm payment:reverse refund:read refund:create refund:approve refund:settle',
      ),
    ],
  },
  {
    code: 'business_owner',
    name: '业务负责人',
    grants: [
      ...employee,
      ...grants(
        'ALL',
        `${sales} ${manager} order:approve_terminate delivery:assign refund:read refund:approve audit:read`,
      ),
      ...grants('IDENTITY', 'role:manage role:grant_business'),
      ...grants('CATALOG', 'product:read product:manage'),
    ],
  },
];

export function grantSignature(items: readonly Grant[]): string {
  return items
    .map((item) => `${item.code}=${item.scopeCode}`)
    .sort()
    .join('|');
}
