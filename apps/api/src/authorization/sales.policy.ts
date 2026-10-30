import type { Grant } from './permission.policy.js';

const ordinary = ['SELF_COLLABORATOR', 'TEAM', 'ALL'] as const;
const managed = ['TEAM', 'ALL'] as const;
const scopes: Record<string, readonly string[]> = {
  'customer:create': ordinary,
  'customer:read': ordinary,
  'customer:update': ordinary,
  'customer:assign': managed,
  'opportunity:create': ordinary,
  'opportunity:read': ordinary,
  'opportunity:update': ordinary,
  'quote:create': ordinary,
  'quote:read': ordinary,
  'quote:submit': ordinary,
  'quote:record_acceptance': ordinary,
  'order:create': ordinary,
  'order:read': ordinary,
  'order:update': ordinary,
  'order:submit': ordinary,
  'order:withdraw': ordinary,
  'order:approve': managed,
  'order:reject': managed,
  'product:read': ['CATALOG'],
  'product:manage': ['CATALOG'],
};

export function salesScopes(grants: readonly Grant[], action: string): string[] {
  if (!Object.hasOwn(scopes, action)) return [];
  return [
    ...new Set(
      grants
        .filter((grant) => grant.code === action && scopes[action]!.includes(grant.scopeCode))
        .map((grant) => grant.scopeCode),
    ),
  ];
}

/** A server-resolved customer root. Collaborators never imply assignment/approval. */
export function visibleSalesRoot(
  scopes: readonly string[],
  actorId: bigint,
  root: { ownerId: bigint; collaboratorIds: readonly bigint[] },
  teamOwner: boolean,
): boolean {
  return (
    scopes.includes('ALL') ||
    (scopes.includes('TEAM') && teamOwner) ||
    (scopes.includes('SELF_COLLABORATOR') &&
      (root.ownerId === actorId || root.collaboratorIds.includes(actorId)))
  );
}
