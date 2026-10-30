import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { AccessIdentity } from '../auth/auth.crypto.js';
import { unauthenticated } from '../auth/auth.crypto.js';
import { ApiException } from '../http/api.exception.js';
import type { Grant, ReadPermission } from './permission.policy.js';
import { hasPermission } from './permission.policy.js';

export interface ReadAuthorization {
  actorId: bigint;
  grants: Grant[];
}

@Injectable()
export class AuthorizationService {
  constructor(private readonly database: PrismaService) {}

  /** A fresh, consistent authorization/data snapshot for each read; never cache it across requests. */
  async withRead<T>(
    identity: AccessIdentity,
    read: (tx: Prisma.TransactionClient, authorization: ReadAuthorization) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.client.$transaction(
        async (tx) => {
          return read(tx, await this.inTransaction(tx, identity));
        },
        { isolationLevel: 'RepeatableRead' },
      );
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException('SERVICE_UNAVAILABLE', 'Authorization dependency unavailable');
    }
  }

  /** Authoritative current-transaction read; writers must first acquire identity locks. */
  async inTransaction(
    tx: Prisma.TransactionClient,
    identity: AccessIdentity,
  ): Promise<ReadAuthorization> {
    const actor = await tx.user.findUnique({
      where: { id: BigInt(identity.sub) },
      select: {
        id: true,
        status: true,
        credentialVersion: true,
        refreshSessions: {
          where: { id: BigInt(identity.sid) },
          select: { revokedAt: true, expiresAt: true },
        },
        roles: {
          where: { role: { status: 'ACTIVE' } },
          select: {
            role: {
              select: {
                id: true,
                permissions: {
                  select: { scopeCode: true, permission: { select: { code: true } } },
                },
              },
            },
          },
        },
      },
    });
    const session = actor?.refreshSessions[0];
    if (
      !actor ||
      actor.status !== 'ACTIVE' ||
      actor.credentialVersion !== identity.cv ||
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now()
    )
      throw unauthenticated();
    const grants = actor.roles.flatMap(({ role }) =>
      role.permissions.map(({ permission, scopeCode }) => ({
        roleId: role.id.toString(),
        code: permission.code,
        scopeCode,
      })),
    );
    return { actorId: actor.id, grants };
  }

  require(authorization: ReadAuthorization, permission: ReadPermission): void {
    if (!hasPermission(authorization.grants, permission))
      throw new ApiException('PERMISSION_DENIED', 'Permission denied');
  }
}
