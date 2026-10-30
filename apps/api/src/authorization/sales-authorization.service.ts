import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AccessIdentity } from '../auth/auth.crypto.js';
import { ApiException } from '../http/api.exception.js';
import { AuthorizationService } from './authorization.service.js';
import { salesScopes, visibleSalesRoot } from './sales.policy.js';

/** Only server-owned repositories resolve this projection, including complete parent-child checks. */
export interface SalesRoot {
  ownerId: bigint;
  collaboratorIds: readonly bigint[];
}
export type SalesRootResolver = (tx: Prisma.TransactionClient) => Promise<SalesRoot | null>;

@Injectable()
export class SalesAuthorizationService {
  constructor(private readonly authorization: AuthorizationService) {}

  withObjectRead<T>(
    identity: AccessIdentity,
    action: string,
    resolve: SalesRootResolver,
    read: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.authorization.withRead(identity, async (tx) => {
      await this.requireObject(tx, identity, action, resolve);
      return read(tx);
    });
  }

  /** No new transaction: call in preflight and again after identity/customer locks for writes/replay. */
  async requireObject(
    tx: Prisma.TransactionClient,
    identity: AccessIdentity,
    action: string,
    resolve: SalesRootResolver,
  ): Promise<void> {
    const { actorId, grants } = await this.authorization.inTransaction(tx, identity);
    const allowed = salesScopes(grants, action);
    if (!allowed.length || allowed.includes('CATALOG') || action === 'customer:create')
      throw new ApiException('PERMISSION_DENIED', 'Permission denied');
    const root = await resolve(tx);
    if (!root) throw new ApiException('RESOURCE_NOT_FOUND', 'Resource not found');
    let teamOwner = false;
    if (allowed.includes('TEAM')) {
      const users = await tx.user.findMany({
        where: { id: { in: [actorId, root.ownerId] } },
        select: { id: true, departmentId: true },
      });
      const actorDepartment = users.find(({ id }) => id === actorId)?.departmentId;
      const ownerDepartment = users.find(({ id }) => id === root.ownerId)?.departmentId;
      if (actorDepartment && ownerDepartment) {
        const departments = await tx.department.findMany({
          select: { id: true, parentId: true, status: true },
          take: 1001,
        });
        if (departments.length > 1000)
          throw new ApiException('SERVICE_UNAVAILABLE', 'Organization exceeds authorization limit');
        const active = new Map(
          departments.filter(({ status }) => status === 'ACTIVE').map((row) => [row.id, row]),
        );
        const seen = new Set<bigint>();
        let current: bigint | null = ownerDepartment;
        while (current !== null) {
          if (seen.has(current))
            throw new ApiException('SERVICE_UNAVAILABLE', 'Invalid organization hierarchy');
          seen.add(current);
          const department = active.get(current);
          if (!department) break;
          if (current === actorDepartment) teamOwner = true;
          current = department.parentId;
        }
      }
    }
    if (!visibleSalesRoot(allowed, actorId, root, teamOwner))
      throw new ApiException('RESOURCE_NOT_FOUND', 'Resource not found');
  }

  async requireCreationOrCatalog(
    tx: Prisma.TransactionClient,
    identity: AccessIdentity,
    action: 'customer:create' | 'product:read' | 'product:manage',
  ): Promise<void> {
    const { grants } = await this.authorization.inTransaction(tx, identity);
    if (!salesScopes(grants, action).length)
      throw new ApiException('PERMISSION_DENIED', 'Permission denied');
  }
}
