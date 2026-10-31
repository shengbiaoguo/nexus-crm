import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AccessIdentity } from '../auth/auth.crypto.js';
import { ApiException } from '../http/api.exception.js';
import { AuthorizationService } from './authorization.service.js';
import { salesScopes, teamDepartmentIds, visibleSalesRoot } from './sales.policy.js';

/** Only server-owned repositories resolve this projection, including complete parent-child checks. */
export interface SalesRoot {
  ownerId: bigint;
  collaboratorIds: readonly bigint[];
}
export type SalesRootResolver = (tx: Prisma.TransactionClient) => Promise<SalesRoot | null>;

@Injectable()
export class SalesAuthorizationService {
  constructor(private readonly authorization: AuthorizationService) {}

  private async team(tx: Prisma.TransactionClient, actorId: bigint): Promise<bigint[]> {
    const actor = await tx.user.findUniqueOrThrow({
      where: { id: actorId },
      select: { departmentId: true },
    });
    if (actor.departmentId === null) return [];
    const departments = await tx.department.findMany({
      select: { id: true, parentId: true, status: true },
      take: 1001,
    });
    return teamDepartmentIds(actor.departmentId, departments);
  }

  /** Server-owned SQL predicate. Caller must AND filters with it, never OR them. */
  async customerWhere(
    tx: Prisma.TransactionClient,
    identity: AccessIdentity,
    action: string,
  ): Promise<Prisma.CustomerWhereInput> {
    const { actorId, grants } = await this.authorization.inTransaction(tx, identity);
    const allowed = salesScopes(grants, action);
    if (!allowed.length || allowed.includes('CATALOG') || action === 'customer:create')
      throw new ApiException('PERMISSION_DENIED', 'Permission denied');
    if (allowed.includes('ALL')) return {};
    const clauses: Prisma.CustomerWhereInput[] = [];
    if (allowed.includes('SELF_COLLABORATOR'))
      clauses.push({ OR: [{ ownerId: actorId }, { members: { some: { userId: actorId } } }] });
    if (allowed.includes('TEAM'))
      clauses.push({ owner: { is: { departmentId: { in: await this.team(tx, actorId) } } } });
    return { OR: clauses };
  }

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
    if (!allowed.includes('ALL') && allowed.includes('TEAM')) {
      const owner = await tx.user.findUnique({
        where: { id: root.ownerId },
        select: { departmentId: true },
      });
      teamOwner =
        owner?.departmentId !== null &&
        owner?.departmentId !== undefined &&
        (await this.team(tx, actorId)).includes(owner.departmentId);
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
