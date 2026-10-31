import type { Prisma } from '../generated/prisma/client.js';
import { ApiException } from '../http/api.exception.js';

/** Trusted server targets, not HTTP DTOs or caller-supplied ownership projections. */
export type CrmTarget =
  | { kind: 'customer'; id: bigint }
  | { kind: 'opportunity'; id: bigint; customerId?: bigint }
  | { kind: 'contact'; id: bigint; customerId: bigint }
  | { kind: 'followUp'; id: bigint; opportunityId: bigint; customerId?: bigint };

export interface CrmLineage {
  target: CrmTarget;
  customerId: bigint;
  opportunityId?: bigint;
}
export const missingCrm = () => new ApiException('RESOURCE_NOT_FOUND', 'Resource not found');
export const numericIds = (ids: readonly bigint[]) =>
  [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Reads parent keys only. Permission must be checked before resolving any target. */
export async function resolveCrmTarget(
  tx: Prisma.TransactionClient,
  target: CrmTarget,
): Promise<CrmLineage> {
  switch (target.kind) {
    case 'customer': {
      const row = await tx.customer.findUnique({ where: { id: target.id }, select: { id: true } });
      if (!row) throw missingCrm();
      return { target, customerId: row.id };
    }
    case 'contact': {
      const row = await tx.customerContact.findFirst({
        where: { id: target.id, customerId: target.customerId },
        select: { customerId: true },
      });
      if (!row) throw missingCrm();
      return { target, customerId: row.customerId };
    }
    case 'opportunity': {
      const row = await tx.opportunity.findFirst({
        where: {
          id: target.id,
          ...(target.customerId === undefined ? {} : { customerId: target.customerId }),
        },
        select: { id: true, customerId: true },
      });
      if (!row) throw missingCrm();
      return { target, customerId: row.customerId, opportunityId: row.id };
    }
    case 'followUp': {
      const row = await tx.followUp.findFirst({
        where: {
          id: target.id,
          opportunityId: target.opportunityId,
          ...(target.customerId === undefined
            ? {}
            : { opportunity: { is: { customerId: target.customerId } } }),
        },
        select: { opportunityId: true, opportunity: { select: { customerId: true } } },
      });
      if (!row) throw missingCrm();
      return { target, customerId: row.opportunity.customerId, opportunityId: row.opportunityId };
    }
    default:
      throw new TypeError(
        'Unsupported CRM target; orders and quotes require their own persistence tasks',
      );
  }
}

export async function customerRoot(
  tx: Prisma.TransactionClient,
  id: bigint,
  scope: Prisma.CustomerWhereInput,
) {
  const row = await tx.customer.findFirst({
    where: { AND: [scope, { id }] },
    select: { id: true, ownerId: true, members: { select: { userId: true }, take: 101 } },
  });
  if (!row) throw missingCrm();
  if (row.members.length > 100)
    throw new ApiException('SERVICE_UNAVAILABLE', 'Customer membership exceeds lock-plan capacity');
  return {
    customerId: row.id,
    ownerId: row.ownerId,
    collaboratorIds: numericIds(row.members.map(({ userId }) => userId)),
  };
}
