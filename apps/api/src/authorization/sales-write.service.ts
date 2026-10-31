import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AccessIdentity } from '../auth/auth.crypto.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../http/api.exception.js';
import type { UserLock } from '../idempotency/idempotency.contract.js';
import { AuthorizationService } from './authorization.service.js';
import { SalesAuthorizationService } from './sales-authorization.service.js';
import { WriteLockService, type IdentityLockPlan } from './write-lock.service.js';
import {
  customerRoot,
  missingCrm,
  numericIds,
  resolveCrmTarget,
  type CrmTarget,
  type CrmLineage,
} from './crm-target.js';

interface BasePlan {
  readonly identity: IdentityLockPlan;
  readonly identityState: string;
  readonly session: string;
}
export interface SalesWritePlan extends BasePlan {
  readonly kind: 'object';
  readonly action: string;
  readonly targets: readonly CrmTarget[];
  readonly lineage: string;
  readonly root: {
    readonly customerId: bigint;
    readonly ownerId: bigint;
    readonly collaboratorIds: readonly bigint[];
  };
  readonly opportunities: readonly bigint[];
  readonly contacts: readonly bigint[];
  readonly followUps: readonly bigint[];
}
export interface SalesCreationPlan extends BasePlan {
  readonly kind: 'creation';
}
const session = (identity: AccessIdentity) => `${identity.sub}:${identity.sid}:${identity.cv}`;
const objectWrites = [
  'customer:update',
  'customer:assign',
  'opportunity:create',
  'opportunity:update',
];
function requireWriteAction(action: string) {
  if (!objectWrites.includes(action))
    throw new ApiException('PERMISSION_DENIED', 'Unsupported CRM write action');
}
const changed = () =>
  new ApiException(
    'VERSION_CONFLICT',
    'Authorization lock targets changed; reload before retrying',
  );
const lineageSignature = (rows: readonly CrmLineage[]) =>
  JSON.stringify(
    rows.map((row) => [
      row.target.kind,
      String(row.target.id),
      String(row.customerId),
      String(row.opportunityId ?? ''),
    ]),
  );
const rootSignature = (root: SalesWritePlan['root']) =>
  `${root.customerId}:${root.ownerId}:${root.collaboratorIds.join(',')}`;

function targetsCopy(targets: readonly CrmTarget[]): readonly CrmTarget[] {
  if (!targets.length || targets.length > 100)
    throw new ApiException('VALIDATION_FAILED', 'Invalid CRM lock target count');
  const ranks = { customer: 0, opportunity: 1, contact: 2, followUp: 3 };
  return Object.freeze(
    targets
      .map((target) => {
        if (!Object.hasOwn(ranks, target.kind)) throw new TypeError('Unsupported CRM target');
        for (const id of Object.values(target).filter((value) => typeof value === 'bigint')) {
          if (id < 1n || id > 18446744073709551615n)
            throw new ApiException('VALIDATION_FAILED', 'Invalid CRM identifier');
        }
        return Object.freeze({ ...target });
      })
      .sort((a, b) => ranks[a.kind] - ranks[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
}

/** Only coordinates authoritative CRM authorization and locks; never executes business transitions. */
@Injectable()
export class SalesWriteService {
  private readonly plans = new WeakSet<object>();
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly sales: SalesAuthorizationService,
    private readonly locks: WriteLockService,
    private readonly audit: AuditService,
  ) {}

  private async identityState(
    tx: Prisma.TransactionClient,
    identity: IdentityLockPlan,
  ): Promise<string> {
    const ids = identity.users.map(({ id }) => BigInt(id));
    const users = await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, departmentId: true },
      orderBy: { id: 'asc' },
    });
    if (users.length !== ids.length) throw missingCrm();
    const memberships = await tx.userRole.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, roleId: true },
      orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
      take: 1001,
    });
    const departments = await tx.department.findMany({
      select: { id: true, parentId: true, status: true },
      orderBy: { id: 'asc' },
      take: 1001,
    });
    if (memberships.length > 1000 || departments.length > 1000)
      throw new ApiException('SERVICE_UNAVAILABLE', 'Identity state exceeds lock-plan capacity');
    return JSON.stringify({ users, memberships, departments }, (_, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  }

  async plan(
    identity: AccessIdentity,
    action: string,
    targets: readonly CrmTarget[],
    relatedUsers: readonly UserLock[] = [],
  ): Promise<SalesWritePlan> {
    requireWriteAction(action);
    const frozenTargets = targetsCopy(targets);
    return this.authorization.withRead(identity, async (tx) => {
      const scope = await this.sales.customerWhere(tx, identity, action);
      const lineage: CrmLineage[] = [];
      for (const target of frozenTargets) lineage.push(await resolveCrmTarget(tx, target));
      const id = lineage[0]!.customerId;
      if (lineage.some((row) => row.customerId !== id)) throw missingCrm();
      const root = await customerRoot(tx, id, scope);
      const users: UserLock[] = [
        ...numericIds([BigInt(identity.sub), root.ownerId, ...root.collaboratorIds]).map(
          (userId) => ({ id: String(userId), mode: 'SHARE' as const }),
        ),
        ...relatedUsers.map((user) => ({ ...user })),
      ];
      if (users.length > 100)
        throw new ApiException('SERVICE_UNAVAILABLE', 'User lock set exceeds command capacity');
      const identityPlan = await this.locks.plan(tx, identity, users);
      const result: SalesWritePlan = Object.freeze({
        kind: 'object',
        action,
        targets: frozenTargets,
        identity: identityPlan,
        session: session(identity),
        identityState: await this.identityState(tx, identityPlan),
        lineage: lineageSignature(lineage),
        root: Object.freeze({ ...root, collaboratorIds: Object.freeze(root.collaboratorIds) }),
        opportunities: Object.freeze(
          numericIds(
            lineage.flatMap((row) => (row.opportunityId === undefined ? [] : [row.opportunityId])),
          ),
        ),
        contacts: Object.freeze(
          numericIds(
            frozenTargets
              .filter((target) => target.kind === 'contact')
              .map(({ id: targetId }) => targetId),
          ),
        ),
        followUps: Object.freeze(
          numericIds(
            frozenTargets
              .filter((target) => target.kind === 'followUp')
              .map(({ id: targetId }) => targetId),
          ),
        ),
      });
      this.plans.add(result);
      return result;
    });
  }

  /** Fresh action/object preflight. Never use a previous request's successful plan as permission. */
  async requireTargets(
    tx: Prisma.TransactionClient,
    identity: AccessIdentity,
    action: string,
    targets: readonly CrmTarget[],
  ): Promise<void> {
    requireWriteAction(action);
    const checkedTargets = targetsCopy(targets);
    const scope = await this.sales.customerWhere(tx, identity, action);
    for (const target of checkedTargets) {
      const row = await resolveCrmTarget(tx, target);
      if (
        !(await tx.customer.findFirst({
          where: { AND: [scope, { id: row.customerId }] },
          select: { id: true },
        }))
      )
        throw missingCrm();
    }
  }

  private async begin(tx: Prisma.TransactionClient, identity: AccessIdentity, plan: BasePlan) {
    this.audit.assertTransaction(tx, 'ReadCommitted');
    if (!this.plans.has(plan) || plan.session !== session(identity))
      throw new TypeError('A fresh server-owned plan for this identity is required');
    await this.locks.acquire(tx, identity, plan.identity);
    if ((await this.identityState(tx, plan.identity)) !== plan.identityState) throw changed();
  }

  /** Same IdempotencyService transaction: identity → customer → Opportunity → Contact → FollowUp. */
  async acquire(
    tx: Prisma.TransactionClient,
    identity: AccessIdentity,
    plan: SalesWritePlan,
  ): Promise<SalesWritePlan['root']> {
    if (plan.kind !== 'object') throw new TypeError('Object lock plan required');
    await this.begin(tx, identity, plan);
    const scope = await this.sales.customerWhere(tx, identity, plan.action);
    await tx.$queryRaw`SELECT id FROM customers WHERE id=${plan.root.customerId} FOR UPDATE`;
    for (const id of plan.opportunities)
      await tx.$queryRaw`SELECT id FROM opportunities WHERE id=${id} FOR UPDATE`;
    for (const id of plan.contacts)
      await tx.$queryRaw`SELECT id FROM customer_contacts WHERE id=${id} FOR UPDATE`;
    for (const id of plan.followUps)
      await tx.$queryRaw`SELECT id FROM follow_ups WHERE id=${id} FOR UPDATE`;
    const current: CrmLineage[] = [];
    for (const target of plan.targets) current.push(await resolveCrmTarget(tx, target));
    // A changed parent chain must first pass current visibility; never reveal a
    // moved, now-invisible resource through a distinguishable version response.
    for (const row of current.filter((entry) => entry.customerId !== plan.root.customerId)) {
      if (
        !(await tx.customer.findFirst({
          where: { AND: [scope, { id: row.customerId }] },
          select: { id: true },
        }))
      )
        throw missingCrm();
    }
    const root = await customerRoot(tx, plan.root.customerId, scope);
    if (
      rootSignature(root) !== rootSignature(plan.root) ||
      lineageSignature(current) !== plan.lineage
    )
      throw changed();
    return root;
  }

  async planCreation(identity: AccessIdentity): Promise<SalesCreationPlan> {
    return this.authorization.withRead(identity, async (tx) => {
      await this.sales.requireCreationOrCatalog(tx, identity, 'customer:create');
      const identityPlan = await this.locks.plan(tx, identity);
      const plan: SalesCreationPlan = Object.freeze({
        kind: 'creation',
        identity: identityPlan,
        session: session(identity),
        identityState: await this.identityState(tx, identityPlan),
      });
      this.plans.add(plan);
      return plan;
    });
  }

  async acquireCreation(
    tx: Prisma.TransactionClient,
    identity: AccessIdentity,
    plan: SalesCreationPlan,
  ): Promise<bigint> {
    if (plan.kind !== 'creation') throw new TypeError('Creation lock plan required');
    await this.begin(tx, identity, plan);
    await this.sales.requireCreationOrCatalog(tx, identity, 'customer:create');
    return BigInt(identity.sub);
  }
}
