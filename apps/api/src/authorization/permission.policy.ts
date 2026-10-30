/** Executable mappings for the M0 read surfaces implemented in this module only. */
const scopes = {
  'user:manage': 'IDENTITY',
  'role:manage': 'IDENTITY',
  'department:read': 'AUTHENTICATED',
} as const;

export type ReadPermission = keyof typeof scopes;
export interface Grant {
  roleId: string;
  code: string;
  scopeCode: string;
}

/** Match the action and its scope in one grant. No role name, ALL or wildcard bypass. */
export function hasPermission(grants: readonly Grant[], permission: string): boolean {
  if (!Object.hasOwn(scopes, permission)) return false;
  return grants.some(
    (grant) =>
      grant.code === permission && grant.scopeCode === scopes[permission as ReadPermission],
  );
}

export function userReadWhere(actorId: bigint, grants: readonly Grant[]) {
  return hasPermission(grants, 'user:manage') ? {} : { id: actorId };
}
