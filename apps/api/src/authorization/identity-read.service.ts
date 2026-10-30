import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AccessIdentity } from '../auth/auth.crypto.js';
import { ApiException } from '../http/api.exception.js';
import { ListResult } from '../http/response.interceptor.js';
import { AuthorizationService } from './authorization.service.js';
import { userReadWhere } from './permission.policy.js';
import type { PageQueryDto } from './identity.dto.js';

const profile = {
  id: true,
  name: true,
  loginName: true,
  departmentId: true,
} satisfies Prisma.UserSelect;
const page = (query: PageQueryDto) => ({
  skip: (query.page - 1) * query.pageSize,
  take: query.pageSize,
});
const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

function list<T>(data: T[], total: number, query: PageQueryDto) {
  return new ListResult(data, {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  });
}

@Injectable()
export class IdentityReadService {
  constructor(private readonly authorization: AuthorizationService) {}

  user(identity: AccessIdentity, id: string) {
    return this.authorization.withRead(identity, async (tx, context) => {
      const result = await tx.user.findFirst({
        where: { AND: [{ id: BigInt(id) }, userReadWhere(context.actorId, context.grants)] },
        select: profile,
      });
      // Unseen and nonexistent objects are indistinguishable; do not fetch first then redact.
      if (!result) throw new ApiException('RESOURCE_NOT_FOUND', 'Resource not found');
      return result;
    });
  }

  users(identity: AccessIdentity, query: PageQueryDto) {
    return this.authorization.withRead(identity, async (tx, context) => {
      this.authorization.require(context, 'user:manage');
      const where = userReadWhere(context.actorId, context.grants);
      const data = await tx.user.findMany({
        where,
        select: profile,
        ...page(query),
        orderBy: [...orderBy],
      });
      return list(data, await tx.user.count({ where }), query);
    });
  }

  roles(identity: AccessIdentity, query: PageQueryDto) {
    return this.authorization.withRead(identity, async (tx, context) => {
      this.authorization.require(context, 'role:manage');
      const data = await tx.role.findMany({
        select: { id: true, code: true, name: true, status: true, version: true },
        ...page(query),
        orderBy: [...orderBy],
      });
      return list(data, await tx.role.count(), query);
    });
  }

  permissions(identity: AccessIdentity, query: PageQueryDto) {
    return this.authorization.withRead(identity, async (tx, context) => {
      this.authorization.require(context, 'role:manage');
      const data = await tx.permission.findMany({
        select: { id: true, code: true, description: true },
        ...page(query),
        orderBy: [...orderBy],
      });
      return list(data, await tx.permission.count(), query);
    });
  }

  departments(identity: AccessIdentity, query: PageQueryDto) {
    return this.authorization.withRead(identity, async (tx, context) => {
      this.authorization.require(context, 'department:read');
      const where = { status: 'ACTIVE' } as const;
      const data = await tx.department.findMany({
        where,
        select: { id: true, name: true, parentId: true },
        ...page(query),
        orderBy: [...orderBy],
      });
      return list(data, await tx.department.count({ where }), query);
    });
  }
}
