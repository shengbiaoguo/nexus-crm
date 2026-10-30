import { Inject, Injectable } from '@nestjs/common';
import type { Environment } from '../config/environment.js';
import type { Prisma, User, RefreshSession } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../http/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { AUTH_ENVIRONMENT } from './auth.config.js';
import {
  AccessTokens,
  newRefreshToken,
  refreshHash,
  unauthenticated,
  verifyPassword,
} from './auth.crypto.js';
import type { AccessIdentity } from './auth.crypto.js';

@Injectable()
export class AuthService {
  private readonly attempts = new Map<string, { count: number; until: number }>();
  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
    @Inject(AUTH_ENVIRONMENT) private readonly environment: Environment,
  ) {}

  private tokens(): AccessTokens {
    if (!this.environment.AUTH_JWT_SECRET)
      throw new ApiException('SERVICE_UNAVAILABLE', 'Authentication is not configured');
    return new AccessTokens(this.environment.AUTH_JWT_SECRET);
  }

  /** Bounded process-local admission control; production ingress must also enforce a shared limit. */
  throttle(ip: string): void {
    const now = Date.now();
    for (const [key, item] of this.attempts) if (item.until <= now) this.attempts.delete(key);
    const item = this.attempts.get(ip);
    if ((item?.count ?? 0) >= 20 || (!item && this.attempts.size >= 10000))
      throw new ApiException('RATE_LIMITED', 'Too many authentication requests');
    this.attempts.set(ip, { count: (item?.count ?? 0) + 1, until: item?.until ?? now + 60000 });
  }

  async login(loginName: string, password: string, requestId: string) {
    const tokens = this.tokens();
    return this.safe(async () => {
      const candidate = await this.database.client.user.findUnique({ where: { loginName } });
      const matches = await verifyPassword(password, candidate?.passwordHash ?? '');
      if (!candidate || !matches) throw unauthenticated();
      return this.transaction(async (tx) => {
        const user = await this.lockUser(tx, candidate.id);
        if (
          !user ||
          user.status !== 'ACTIVE' ||
          user.passwordHash !== candidate.passwordHash ||
          user.credentialVersion !== candidate.credentialVersion
        )
          throw unauthenticated();
        const refreshToken = newRefreshToken();
        const session = await tx.refreshSession.create({
          data: {
            userId: user.id,
            tokenHash: refreshHash(refreshToken),
            expiresAt: new Date(Date.now() + 7 * 86400000),
          },
        });
        await this.record(tx, 'auth.login', user, session, requestId);
        return this.pair(tokens, user, session, refreshToken);
      });
    });
  }

  async refresh(refreshToken: string, requestId: string) {
    const tokens = this.tokens();
    return this.safe(async () => {
      const hash = refreshHash(refreshToken);
      const candidate = await this.database.client.refreshSession.findUnique({
        where: { tokenHash: hash },
      });
      if (!candidate) throw unauthenticated();
      return this.transaction(async (tx) => {
        const user = await this.lockUser(tx, candidate.userId);
        // Current locking read after the shared user lock: concurrent refresh cannot reuse a stale snapshot.
        const session = await this.lockSession(tx, candidate.id);
        this.active(user, session);
        if (session!.tokenHash !== hash) throw unauthenticated();
        const next = newRefreshToken();
        await tx.refreshSession.update({
          where: { id: candidate.id },
          data: { tokenHash: refreshHash(next) },
        });
        await this.record(tx, 'auth.refresh', user!, session!, requestId);
        return this.pair(tokens, user!, session!, next);
      });
    });
  }

  async authenticate(header: string | undefined): Promise<AccessIdentity> {
    const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(header ?? '');
    if (!match) throw unauthenticated();
    const identity = await this.tokens().verify(match[1]!);
    return this.safe(async () => {
      const session = await this.database.client.refreshSession.findUnique({
        where: { id: BigInt(identity.sid) },
        include: { user: true },
      });
      this.active(session?.user ?? null, session);
      if (
        session!.userId.toString() !== identity.sub ||
        session!.user.credentialVersion !== identity.cv
      )
        throw unauthenticated();
      return identity;
    });
  }

  async logout(identity: AccessIdentity, requestId: string): Promise<void> {
    return this.safe(() =>
      this.transaction(async (tx) => {
        const user = await this.lockUser(tx, BigInt(identity.sub));
        const session = await this.lockSession(tx, BigInt(identity.sid));
        this.active(user, session);
        if (session!.userId !== user!.id || user!.credentialVersion !== identity.cv)
          throw unauthenticated();
        await tx.refreshSession.update({
          where: { id: session!.id },
          data: { revokedAt: new Date() },
        });
        await this.record(tx, 'auth.logout', user!, session!, requestId);
      }),
    );
  }

  async me(identity: AccessIdentity) {
    return this.safe(async () => {
      const user = await this.database.client.user.findUnique({
        where: { id: BigInt(identity.sub) },
        include: {
          refreshSessions: { where: { id: BigInt(identity.sid) } },
          roles: {
            where: { role: { status: 'ACTIVE' } },
            include: {
              role: {
                include: {
                  permissions: { include: { permission: true } },
                },
              },
            },
          },
        },
      });
      this.active(user, user?.refreshSessions[0]);
      if (user!.credentialVersion !== identity.cv) throw unauthenticated();
      return {
        id: user!.id.toString(),
        loginName: user!.loginName,
        name: user!.name,
        permissions: user!.roles.flatMap(({ role }) =>
          role.permissions.map(({ permission, scopeCode }) => ({
            roleCode: role.code,
            code: permission.code,
            scope: scopeCode,
          })),
        ),
      };
    });
  }

  private active(user: User | null | undefined, session: RefreshSession | null | undefined): void {
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now()
    )
      throw unauthenticated();
  }
  private async lockUser(tx: Prisma.TransactionClient, id: bigint) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
    // Let Prisma map unsigned INT to number; raw MySQL results may return bigint instead.
    return tx.user.findUnique({ where: { id } });
  }
  private async lockSession(tx: Prisma.TransactionClient, id: bigint) {
    await tx.$queryRaw`SELECT id FROM refresh_sessions WHERE id = ${id} FOR UPDATE`;
    return tx.refreshSession.findUnique({ where: { id } });
  }
  private transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.audit.withTransaction(this.database.client, work, {
      isolationLevel: 'ReadCommitted',
    });
  }
  private record(
    tx: Prisma.TransactionClient,
    action: string,
    user: User,
    session: RefreshSession,
    requestId: string,
  ) {
    return this.audit.recordSuccess(tx, {
      actorId: user.id.toString(),
      entityType: 'refresh_session',
      entityId: session.id.toString(),
      requestId,
      action,
    });
  }
  private async pair(
    tokens: AccessTokens,
    user: User,
    session: RefreshSession,
    refreshToken: string,
  ) {
    return {
      accessToken: await tokens.sign({
        sub: user.id.toString(),
        sid: session.id.toString(),
        cv: user.credentialVersion,
      }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: 900,
      refreshExpiresAt: session.expiresAt.toISOString(),
    };
  }
  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiException) throw error;
      // No automatic retries: a lost COMMIT acknowledgement may already have rotated the credential.
      throw new ApiException(
        'SERVICE_UNAVAILABLE',
        'Authentication dependency unavailable; log in again if needed',
      );
    }
  }
}
