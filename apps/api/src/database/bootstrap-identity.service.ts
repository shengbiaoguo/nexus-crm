import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient, Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { hashPassword } from '../auth/auth.crypto.js';
import { ApiException } from '../http/api.exception.js';
import { grantSignature, roleDefinitions } from './seed-data.js';

export const bootstrapInput = z
  .object({
    loginName: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    password: z
      .string()
      .min(16)
      .max(256)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
const conflict = () =>
  new ApiException(
    'BUSINESS_RULE_VIOLATION',
    'Bootstrap requires an unassigned, unchanged baseline and a new login',
  );

@Injectable()
export class BootstrapIdentityService {
  constructor(private readonly audit: AuditService) {}

  private async baseline(tx: Pick<Prisma.TransactionClient, 'role' | 'userRole'>) {
    const role = await tx.role.findUnique({
      where: { code: 'business_owner' },
      include: { permissions: { include: { permission: true } } },
    });
    const expected = roleDefinitions.find(({ code }) => code === 'business_owner')!;
    if (
      !role ||
      role.status !== 'ACTIVE' ||
      role.name !== expected.name ||
      grantSignature(
        role.permissions.map(({ permission, scopeCode }) => ({ code: permission.code, scopeCode })),
      ) !== grantSignature(expected.grants)
    )
      throw conflict();
    // Even disabled owners block bootstrap: this entrypoint is never an account recovery bypass.
    if (await tx.userRole.count({ where: { roleId: role.id } })) throw conflict();
    return role;
  }

  /** Explicit operator invocation only; never called by seed, application startup or migrations. */
  async initialize(client: PrismaClient, raw: unknown): Promise<{ id: string }> {
    const parsed = bootstrapInput.safeParse(raw);
    if (!parsed.success) throw new ApiException('VALIDATION_FAILED', 'Invalid bootstrap input');
    const { loginName, name, password } = parsed.data;
    const role = await this.baseline(client);
    if (await client.user.findUnique({ where: { loginName }, select: { id: true } }))
      throw conflict();
    const passwordHash = await hashPassword(password);
    const context = {
      systemActor: 'bootstrap:identity',
      entityType: 'user',
      entityId: 'new',
      requestId: randomUUID(),
    };
    const attemptId = await this.audit.startAttempt(client, {
      ...context,
      operationId: 'identity.bootstrap',
      idempotencyScope: 'system:bootstrap:identity',
      idempotencyKey: randomUUID(),
      requestHash: createHash('sha256').update(JSON.stringify({ loginName, name })).digest('hex'),
    });
    let completed = false;
    try {
      return await this.audit.withTransaction(
        client,
        async (tx) => {
          // New user has no pre-existing row to lock. Serialize the one-time grant on the protected role.
          await tx.$queryRaw`SELECT id FROM roles WHERE id = ${role.id} FOR UPDATE`;
          await this.baseline(tx);
          if (await tx.user.findUnique({ where: { loginName }, select: { id: true } }))
            throw conflict();
          const user = await tx.user.create({ data: { loginName, name, passwordHash } });
          await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
          const id = String(user.id);
          await this.audit.recordSuccess(tx, {
            ...context,
            action: 'identity.bootstrap',
            attemptId,
            createdEntityId: id,
            resultRef: `user:${id}`,
            after: { value: { id, roleCode: 'business_owner' }, fields: ['id', 'roleCode'] },
          });
          completed = true;
          return { id };
        },
        { isolationLevel: 'ReadCommitted', timeout: 10000 },
      );
    } catch (error) {
      if (!completed && error instanceof ApiException && error.code === 'BUSINESS_RULE_VIOLATION')
        await this.audit.recordFailureAfterRollback(client, attemptId, error.code);
      else await this.audit.markUnknown(client, attemptId);
      if (error instanceof ApiException) throw error;
      throw new ApiException(
        'SERVICE_UNAVAILABLE',
        'Bootstrap outcome requires operator verification',
      );
    }
  }
}
