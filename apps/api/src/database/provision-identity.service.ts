import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { hashPassword } from '../auth/auth.crypto.js';
import { ApiException } from '../http/api.exception.js';
import { bootstrapInput } from './bootstrap-identity.service.js';

/** Explicit local operator tool: new unassigned employees only, never recovery or grants. */
@Injectable()
export class ProvisionIdentityService {
  constructor(private readonly audit: AuditService) {}

  async create(client: PrismaClient, raw: unknown): Promise<{ id: string }> {
    const parsed = bootstrapInput.safeParse(raw);
    if (!parsed.success) throw new ApiException('VALIDATION_FAILED', 'Invalid identity input');
    const { loginName, name, password } = parsed.data;
    const conflict = () =>
      new ApiException(
        'BUSINESS_RULE_VIOLATION',
        'A new login is required; existing accounts are never overwritten',
      );
    if (await client.user.findUnique({ where: { loginName }, select: { id: true } }))
      throw conflict();
    const passwordHash = await hashPassword(password);
    const context = {
      systemActor: 'provision:identity',
      entityType: 'user',
      entityId: 'new',
      requestId: randomUUID(),
    };
    const attemptId = await this.audit.startAttempt(client, {
      ...context,
      operationId: 'identity.provision',
      idempotencyScope: 'system:provision:identity',
      idempotencyKey: randomUUID(),
      requestHash: createHash('sha256').update(JSON.stringify({ loginName, name })).digest('hex'),
    });
    let ready = false;
    try {
      return await this.audit.withTransaction(
        client,
        async (tx) => {
          const user = await tx.user.create({ data: { loginName, name, passwordHash } });
          const id = String(user.id);
          await this.audit.recordSuccess(tx, {
            ...context,
            action: 'identity.provision',
            attemptId,
            createdEntityId: id,
            resultRef: `user:${id}`,
            after: { value: { id, status: user.status }, fields: ['id', 'status'] },
          });
          ready = true;
          return { id };
        },
        { isolationLevel: 'ReadCommitted', timeout: 10000 },
      );
    } catch (error) {
      if (
        !ready &&
        (error instanceof ApiException ||
          (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
      ) {
        await this.audit.recordFailureAfterRollback(
          client,
          attemptId,
          error instanceof ApiException ? error.code : 'BUSINESS_RULE_VIOLATION',
        );
        throw error instanceof ApiException ? error : conflict();
      }
      await this.audit.markUnknown(client, attemptId);
      throw new ApiException(
        'SERVICE_UNAVAILABLE',
        'Provisioning outcome requires operator verification',
      );
    }
  }
}
