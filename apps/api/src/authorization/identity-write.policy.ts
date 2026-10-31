import { ApiException } from '../http/api.exception.js';
import type { Grant } from './permission.policy.js';

export function isBusinessRole(grants: readonly { code: string; scopeCode: string }[]): boolean {
  return grants.some(
    ({ code, scopeCode }) =>
      !(
        (code === 'department:read' && scopeCode === 'AUTHENTICATED') ||
        (['user:manage', 'role:manage', 'audit:read'].includes(code) && scopeCode === 'IDENTITY')
      ),
  );
}

export function requireBusinessGrant(
  grants: readonly Grant[],
  ownerRoleId: bigint,
  actorId: bigint,
  targetId: bigint,
): void {
  if (
    actorId === targetId ||
    !grants.some(
      (grant) =>
        grant.roleId === ownerRoleId.toString() &&
        grant.code === 'role:grant_business' &&
        grant.scopeCode === 'IDENTITY',
    )
  )
    throw new ApiException(
      'PERMISSION_DENIED',
      'A different business authorization owner is required',
    );
}
