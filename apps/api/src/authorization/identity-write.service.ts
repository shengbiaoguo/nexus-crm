import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AccessIdentity } from '../auth/auth.crypto.js';
import { ApiException } from '../http/api.exception.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { grantSignature, roleDefinitions } from '../database/seed-data.js';
import { AuthorizationService } from './authorization.service.js';
import { hasPermission } from './permission.policy.js';
import { WriteLockService } from './write-lock.service.js';
import { isBusinessRole, requireBusinessGrant } from './identity-write.policy.js';
import type { AssignRolesDto, IdentityCommandDto } from './identity-write.dto.js';

const sorted = (ids: readonly bigint[]) =>
  [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const same = (a: readonly bigint[], b: readonly bigint[]) =>
  String(sorted(a)) === String(sorted(b));
const denied = () =>
  new ApiException(
    'BUSINESS_RULE_VIOLATION',
    'Identity change is not allowed in the current state',
  );
const unavailable = () =>
  new ApiException('SERVICE_UNAVAILABLE', 'Protected identity baseline unavailable');

type ManagedRole = {
  id: bigint;
  permissions: { scopeCode: string; permission: { code: string } }[];
};
function requiresBusiness(
  current: ManagedRole[],
  desired: ManagedRole[] | undefined,
  ownerId: bigint,
) {
  if (
    current.some(
      (role) =>
        role.id === ownerId ||
        role.permissions.some(({ permission }) => permission.code === 'role:grant_business'),
    )
  )
    return true;
  if (!desired) return false;
  return [...current, ...desired].some(
    (role) =>
      current.some(({ id }) => id === role.id) !== desired.some(({ id }) => id === role.id) &&
      (role.id === ownerId ||
        isBusinessRole(
          role.permissions.map(({ permission, scopeCode }) => ({
            code: permission.code,
            scopeCode,
          })),
        )),
  );
}

@Injectable()
export class IdentityWriteService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly locks: WriteLockService,
    private readonly commands: IdempotencyService,
  ) {}

  accessState(identity: AccessIdentity, targetId: string) {
    return this.authorization.withRead(identity, async (tx, auth) => {
      if (!hasPermission(auth.grants, 'role:manage'))
        this.authorization.require(auth, 'user:manage');
      const user = await tx.user.findUnique({
        where: { id: BigInt(targetId) },
        select: {
          id: true,
          status: true,
          version: true,
          roles: { select: { roleId: true }, take: 1001 },
        },
      });
      if (!user) throw new ApiException('RESOURCE_NOT_FOUND', 'User not found');
      if (user.roles.length > 1000)
        throw new ApiException('SERVICE_UNAVAILABLE', 'Memberships exceed command limit');
      return {
        id: String(user.id),
        status: user.status,
        version: user.version,
        roleIds: sorted(user.roles.map(({ roleId }) => roleId)).map(String),
      };
    });
  }

  assignRoles(
    identity: AccessIdentity,
    targetId: string,
    input: AssignRolesDto,
    key: unknown,
    requestId: string,
  ) {
    return this.change(
      identity,
      targetId,
      input,
      key,
      requestId,
      sorted(input.roleIds.map(BigInt)),
    );
  }

  disable(
    identity: AccessIdentity,
    targetId: string,
    input: IdentityCommandDto,
    key: unknown,
    requestId: string,
  ) {
    return this.change(identity, targetId, input, key, requestId);
  }

  private async protectedOwner(tx: Prisma.TransactionClient) {
    const role = await tx.role.findUnique({
      where: { code: 'business_owner' },
      include: { permissions: { include: { permission: true } } },
    });
    const baseline = roleDefinitions.find(({ code }) => code === 'business_owner')!;
    if (
      !role ||
      role.status !== 'ACTIVE' ||
      role.name !== baseline.name ||
      grantSignature(
        role.permissions.map(({ permission, scopeCode }) => ({ code: permission.code, scopeCode })),
      ) !== grantSignature(baseline.grants)
    )
      throw unavailable();
    return role;
  }

  private async ownerMembers(tx: Prisma.TransactionClient, roleId: bigint) {
    const rows = await tx.userRole.findMany({
      where: { roleId },
      select: { userId: true },
      take: 99,
    });
    // Reserve actor + target within the existing 100-user transaction lock bound.
    if (rows.length > 98)
      throw new ApiException('SERVICE_UNAVAILABLE', 'Owner lock set exceeds command limit');
    return sorted(rows.map(({ userId }) => userId));
  }

  private async change(
    identity: AccessIdentity,
    targetId: string,
    input: IdentityCommandDto,
    key: unknown,
    requestId: string,
    desired?: bigint[],
  ) {
    const permission = desired ? 'role:manage' : 'user:manage';
    const target = BigInt(targetId);
    const dto = {
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      ...(desired ? { roleIds: desired.map(String) } : {}),
    };
    const setup = await this.authorization.withRead(identity, async (tx, auth) => {
      this.authorization.require(auth, permission);
      const owner = await this.protectedOwner(tx);
      const members = await this.ownerMembers(tx, owner.id);
      const users = sorted([...members, auth.actorId, target]).map((id) => ({
        id: String(id),
        mode: 'UPDATE' as const,
      }));
      const plan = await this.locks.plan(tx, identity, users, {
        additional: desired ?? [],
        exclusive: [owner.id],
      });
      return { ownerId: owner.id, members, plan };
    });
    const operationId = desired ? 'identity.assignRoles' : 'identity.disable';
    return this.commands.execute({
      identity,
      key,
      requestId,
      operationId,
      entityType: 'user',
      entityId: targetId,
      targets: { userId: targetId },
      dto,
      responseFields: ['id', 'status', 'version'],
      userLocks: setup.plan.users,
      authorize: async (tx, phase) => {
        if (phase === 'transaction') await this.locks.acquire(tx, identity, setup.plan);
        const auth = await this.authorization.inTransaction(tx, identity);
        this.authorization.require(auth, permission);
        const owner = await this.protectedOwner(tx);
        if (
          owner.id !== setup.ownerId ||
          !same(await this.ownerMembers(tx, owner.id), setup.members)
        )
          throw new ApiException(
            'VERSION_CONFLICT',
            'Owner lock targets changed; reload before retrying',
          );
        const user = await tx.user.findUnique({
          where: { id: target },
          include: {
            roles: {
              include: { role: { include: { permissions: { include: { permission: true } } } } },
            },
          },
        });
        if (!user) throw new ApiException('RESOURCE_NOT_FOUND', 'User not found');
        const requested = desired
          ? await tx.role.findMany({
              where: { id: { in: desired } },
              include: { permissions: { include: { permission: true } } },
            })
          : [];
        const business = requiresBusiness(
          user.roles.map(({ role }) => role),
          desired ? requested : undefined,
          owner.id,
        );
        // A replay of a completed removal must retain its additional authorization
        // requirement even though the target no longer has the removed roles.
        const prior =
          typeof key === 'string'
            ? await tx.commandAttempt.findFirst({
                where: {
                  actorId: auth.actorId,
                  idempotencyScope: `user:${identity.sub}`,
                  idempotencyKey: key.toLowerCase(),
                  operationId,
                  entityId: targetId,
                  status: 'SUCCEEDED',
                },
                select: { auditLogs: { select: { afterJson: true } } },
              })
            : null;
        const priorSnapshot = prior?.auditLogs[0]?.afterJson;
        if (
          prior &&
          (!priorSnapshot ||
            typeof priorSnapshot !== 'object' ||
            Array.isArray(priorSnapshot) ||
            typeof priorSnapshot['businessChange'] !== 'boolean')
        )
          throw new ApiException('AUDIT_UNAVAILABLE', 'Authorization history unavailable');
        const priorBusiness =
          priorSnapshot &&
          typeof priorSnapshot === 'object' &&
          !Array.isArray(priorSnapshot) &&
          priorSnapshot['businessChange'] === true;
        if (business || priorBusiness)
          requireBusinessGrant(auth.grants, owner.id, auth.actorId, target);
      },
      execute: async (tx, normalized) => {
        const { expectedVersion, reason } = normalized as typeof dto;
        const user = await tx.user.findUniqueOrThrow({
          where: { id: target },
          include: {
            roles: {
              include: { role: { include: { permissions: { include: { permission: true } } } } },
            },
          },
        });
        if (user.version !== expectedVersion)
          throw new ApiException('VERSION_CONFLICT', 'User version does not match');
        if (user.status !== 'ACTIVE') throw denied();
        const beforeRoles = sorted(user.roles.map(({ roleId }) => roleId));
        const losingOwner =
          beforeRoles.includes(setup.ownerId) && (!desired || !desired.includes(setup.ownerId));
        if (
          losingOwner &&
          (await tx.user.count({
            where: { status: 'ACTIVE', roles: { some: { roleId: setup.ownerId } } },
          })) <= 1
        )
          throw denied();
        let businessChange = requiresBusiness(
          user.roles.map(({ role }) => role),
          undefined,
          setup.ownerId,
        );
        if (desired) {
          const roles = await tx.role.findMany({
            where: { id: { in: desired }, status: 'ACTIVE' },
            include: { permissions: { include: { permission: true } } },
          });
          if (roles.length !== desired.length)
            throw new ApiException('RESOURCE_NOT_FOUND', 'Active role not found');
          if (same(beforeRoles, desired)) throw denied();
          businessChange = requiresBusiness(
            user.roles.map(({ role }) => role),
            roles,
            setup.ownerId,
          );
          await tx.userRole.deleteMany({ where: { userId: target, roleId: { notIn: desired } } });
          const additions = desired.filter((id) => !beforeRoles.includes(id));
          if (additions.length)
            await tx.userRole.createMany({
              data: additions.map((roleId) => ({ userId: target, roleId })),
            });
        } else {
          if (user.credentialVersion === 4294967295) throw denied();
          await tx.refreshSession.updateMany({
            where: { userId: target, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        const updated = await tx.user.update({
          where: { id: target },
          data: {
            version: { increment: 1 },
            ...(!desired ? { status: 'DISABLED', credentialVersion: { increment: 1 } } : {}),
          },
        });
        return {
          httpStatus: 200,
          body: { id: targetId, status: updated.status, version: updated.version },
          audit: {
            before: {
              value: {
                status: user.status,
                version: user.version,
                roleIds: beforeRoles.map(String),
              },
              fields: ['status', 'version', 'roleIds'],
            },
            after: {
              value: {
                status: updated.status,
                version: updated.version,
                roleIds: (desired ?? beforeRoles).map(String),
                businessChange,
                reason,
              },
              fields: ['status', 'version', 'roleIds', 'businessChange', 'reason'],
            },
          },
        };
      },
    });
  }
}
