import { Injectable } from '@nestjs/common';
import type { AccessIdentity } from '../auth/auth.crypto.js';
import { ApiException } from '../http/api.exception.js';
import { AuthorizationService } from './authorization.service.js';
import { SalesAuthorizationService } from './sales-authorization.service.js';
import { missingCrm } from './crm-target.js';

export interface SalesPage {
  page: number;
  pageSize: number;
}
function pageArguments(page: SalesPage) {
  if (
    !Number.isInteger(page.page) ||
    page.page < 1 ||
    page.page > 1000000 ||
    !Number.isInteger(page.pageSize) ||
    page.pageSize < 1 ||
    page.pageSize > 100
  )
    throw new ApiException('VALIDATION_FAILED', 'Invalid pagination');
  return { skip: (page.page - 1) * page.pageSize, take: page.pageSize };
}
const customerSummary = {
  id: true,
  name: true,
  ownerId: true,
  status: true,
  version: true,
  createdAt: true,
} as const;
const opportunitySummary = {
  id: true,
  customerId: true,
  ownerId: true,
  title: true,
  stage: true,
  version: true,
  createdAt: true,
} as const;
const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

/** Internal scoped repository only. No CRM HTTP routes or business state transitions. */
@Injectable()
export class SalesAccessService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly sales: SalesAuthorizationService,
  ) {}

  customers(identity: AccessIdentity, page: SalesPage) {
    const pagination = pageArguments(page);
    return this.authorization.withRead(identity, async (tx) => {
      const where = await this.sales.customerWhere(tx, identity, 'customer:read');
      const data = await tx.customer.findMany({
        where,
        select: customerSummary,
        orderBy: [...orderBy],
        ...pagination,
      });
      const total = await tx.customer.count({ where });
      return { data, total };
    });
  }

  customer(identity: AccessIdentity, id: bigint) {
    return this.authorization.withRead(identity, async (tx) => {
      const scope = await this.sales.customerWhere(tx, identity, 'customer:read');
      const row = await tx.customer.findFirst({
        where: { AND: [scope, { id }] },
        select: customerSummary,
      });
      if (!row) throw missingCrm();
      return row;
    });
  }

  opportunities(identity: AccessIdentity, page: SalesPage, customerId?: bigint) {
    const pagination = pageArguments(page);
    return this.authorization.withRead(identity, async (tx) => {
      const scope = await this.sales.customerWhere(tx, identity, 'opportunity:read');
      if (
        customerId !== undefined &&
        !(await tx.customer.findFirst({
          where: { AND: [scope, { id: customerId }] },
          select: { id: true },
        }))
      )
        throw missingCrm();
      const where = {
        customer: { is: scope },
        ...(customerId === undefined ? {} : { customerId }),
      };
      const data = await tx.opportunity.findMany({
        where,
        select: opportunitySummary,
        orderBy: [...orderBy],
        ...pagination,
      });
      const total = await tx.opportunity.count({ where });
      return { data, total };
    });
  }

  opportunity(identity: AccessIdentity, id: bigint, customerId?: bigint) {
    return this.authorization.withRead(identity, async (tx) => {
      const scope = await this.sales.customerWhere(tx, identity, 'opportunity:read');
      const row = await tx.opportunity.findFirst({
        where: { id, customer: { is: scope }, ...(customerId === undefined ? {} : { customerId }) },
        select: opportunitySummary,
      });
      if (!row) throw missingCrm();
      return row;
    });
  }

  contact(identity: AccessIdentity, customerId: bigint, id: bigint) {
    return this.authorization.withRead(identity, async (tx) => {
      const scope = await this.sales.customerWhere(tx, identity, 'customer:read');
      const row = await tx.customerContact.findFirst({
        where: { id, customerId, customer: { is: scope } },
        select: { id: true, customerId: true, status: true, version: true },
      });
      if (!row) throw missingCrm();
      return row;
    });
  }

  followUp(identity: AccessIdentity, opportunityId: bigint, id: bigint) {
    return this.authorization.withRead(identity, async (tx) => {
      const scope = await this.sales.customerWhere(tx, identity, 'opportunity:read');
      const row = await tx.followUp.findFirst({
        where: { id, opportunityId, opportunity: { is: { customer: { is: scope } } } },
        select: { id: true, opportunityId: true, createdAt: true },
      });
      if (!row) throw missingCrm();
      return row;
    });
  }
}
