import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AccessIdentity } from '../auth/auth.crypto.js';
import { userLockPlan } from '../idempotency/idempotency.contract.js';
import type { UserLock } from '../idempotency/idempotency.contract.js';
import { ApiException } from '../http/api.exception.js';
import { AuditService } from '../audit/audit.service.js';

export interface IdentityLockPlan {
  users: readonly UserLock[];
  roles: readonly bigint[];
  departments: readonly bigint[];
  additionalRoles?: readonly bigint[];
  exclusiveRoles?: readonly bigint[];
}
const sorted = (ids: readonly bigint[]) =>
  [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

@Injectable()
export class WriteLockService {
  private readonly acquired = new WeakSet<object>();
  constructor(private readonly audit: AuditService) {}
  /** Resolve before the business transaction; pass users to IdempotencyService.userLocks too. */
  async plan(
    tx: Prisma.TransactionClient,
    identity: AccessIdentity,
    relatedUsers: readonly UserLock[] = [],
    roleOptions: { additional?: readonly bigint[]; exclusive?: readonly bigint[] } = {},
  ): Promise<IdentityLockPlan> {
    const users = userLockPlan(identity.sub, relatedUsers);
    const memberships = await tx.userRole.findMany({
      where: { userId: { in: users.map(({ id }) => BigInt(id)) } },
      select: { roleId: true },
      take: 1001,
    });
    if (memberships.length > 1000)
      throw new ApiException('SERVICE_UNAVAILABLE', 'Memberships exceed lock limit');
    // Small single-enterprise organization: protect the whole tree, including disabled nodes.
    const departments = await tx.department.findMany({ select: { id: true }, take: 1001 });
    if (departments.length > 1000)
      throw new ApiException('SERVICE_UNAVAILABLE', 'Organization exceeds lock limit');
    return Object.freeze({
      users: Object.freeze(users.map((user) => Object.freeze(user))),
      roles: Object.freeze(
        sorted([
          ...memberships.map(({ roleId }) => roleId),
          ...(roleOptions.additional ?? []),
          ...(roleOptions.exclusive ?? []),
        ]),
      ),
      departments: Object.freeze(sorted(departments.map(({ id }) => id))),
      additionalRoles: Object.freeze(sorted(roleOptions.additional ?? [])),
      exclusiveRoles: Object.freeze(sorted(roleOptions.exclusive ?? [])),
    });
  }

  /** Same caller tx, before customer/order/child locks. Never upgrade after a later tier. */
  async acquire(
    tx: Prisma.TransactionClient,
    identity: AccessIdentity,
    plan: IdentityLockPlan,
  ): Promise<void> {
    this.audit.assertTransaction(tx);
    if (this.acquired.has(tx))
      throw new TypeError('Acquire the complete identity plan once per transaction');
    this.acquired.add(tx);
    const normalized = userLockPlan(identity.sub, plan.users);
    if (
      JSON.stringify(normalized) !== JSON.stringify(plan.users) ||
      String(sorted(plan.roles)) !== String(plan.roles) ||
      String(sorted(plan.departments)) !== String(plan.departments)
    )
      throw new TypeError('Noncanonical identity lock plan');
    for (const user of plan.users) {
      if (user.mode === 'UPDATE')
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${BigInt(user.id)} FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM users WHERE id = ${BigInt(user.id)} FOR SHARE`;
    }
    if ((plan.exclusiveRoles ?? []).some((id) => !plan.roles.includes(id)))
      throw new TypeError('Exclusive roles must be part of the complete plan');
    for (const id of plan.roles) {
      if (plan.exclusiveRoles?.includes(id))
        await tx.$queryRaw`SELECT id FROM roles WHERE id = ${id} FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM roles WHERE id = ${id} FOR SHARE`;
    }
    for (const id of plan.departments)
      await tx.$queryRaw`SELECT id FROM departments WHERE id = ${id} FOR SHARE`;
    const current = await this.plan(tx, identity, plan.users, {
      additional: plan.additionalRoles ?? [],
      exclusive: plan.exclusiveRoles ?? [],
    });
    if (
      String(current.roles) !== String(plan.roles) ||
      String(current.departments) !== String(plan.departments)
    )
      throw new ApiException(
        'VERSION_CONFLICT',
        'Authorization lock targets changed; reload before retrying',
      );
  }
}
