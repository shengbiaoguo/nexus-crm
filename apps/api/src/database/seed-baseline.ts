import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { grantSignature, permissionCodes, roleDefinitions } from './seed-data.js';
import { AuditService } from '../audit/audit.service.js';
import { StructuredLogger } from '../logging/structured-logger.service.js';

export async function seedBaseline(client: PrismaClient): Promise<{ created: boolean }> {
  // Preflight is repeated under SERIALIZABLE; changed templates are never silently restored.
  const audit = new AuditService(new StructuredLogger());
  const requestId = randomUUID();
  const context = {
    systemActor: 'seed:m0',
    entityType: 'permission_dictionary',
    entityId: 'm0-v1',
    requestId,
  };
  const attemptId = await audit.startAttempt(client, {
    ...context,
    operationId: 'seedM0Baseline',
    idempotencyScope: 'system:seed:m0',
    idempotencyKey: randomUUID(),
    requestHash: createHash('sha256').update(JSON.stringify(roleDefinitions)).digest('hex'),
  });
  let callbackCompleted = false;
  try {
    return await audit.withTransaction(
      client,
      async (tx) => {
        const existingRoles = await tx.role.findMany({
          where: { code: { in: roleDefinitions.map((role) => role.code) } },
          include: { permissions: { include: { permission: true } } },
        });
        for (const definition of roleDefinitions) {
          const existing = existingRoles.find((role) => role.code === definition.code);
          if (
            existing &&
            (existing.name !== definition.name ||
              existing.status !== 'ACTIVE' ||
              grantSignature(
                existing.permissions.map((grant) => ({
                  code: grant.permission.code,
                  scopeCode: grant.scopeCode,
                })),
              ) !== grantSignature(definition.grants))
          ) {
            throw new Error('SEED_TEMPLATE_CONFLICT');
          }
        }
        const known = await tx.permission.findMany({ where: { code: { in: permissionCodes } } });
        if (known.some((item) => item.description !== `M0 capability: ${item.code}`))
          throw new Error('SEED_DICTIONARY_CONFLICT');
        const changed =
          existingRoles.length !== roleDefinitions.length ||
          known.length !== permissionCodes.length;
        for (const code of permissionCodes.filter(
          (code) => !known.some((item) => item.code === code),
        )) {
          await tx.permission.create({ data: { code, description: `M0 capability: ${code}` } });
        }
        for (const definition of roleDefinitions.filter(
          (definition) => !existingRoles.some((role) => role.code === definition.code),
        )) {
          await tx.role.create({
            data: {
              code: definition.code,
              name: definition.name,
              permissions: {
                create: definition.grants.map((grant) => ({
                  scopeCode: grant.scopeCode,
                  permission: { connect: { code: grant.code } },
                })),
              },
            },
          });
        }
        if (changed) {
          await audit.recordSuccess(tx, {
            ...context,
            action: 'm0.baseline_initialized',
            attemptId,
            after: {
              value: {
                roles: roleDefinitions.map((role) => role.code),
                permissionCount: permissionCodes.length,
              },
              fields: ['roles', 'permissionCount'],
            },
            resultRef: 'permission_dictionary:m0-v1',
          });
        } else {
          await audit.recordReplay(tx, {
            ...context,
            attemptId,
            resultRef: 'permission_dictionary:m0-v1',
          });
        }
        callbackCompleted = true;
        return { created: changed };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 },
    );
  } catch (error) {
    // Only our explicit template rejection proves a rollback. Driver/commit failures remain unknown.
    if (
      !callbackCompleted &&
      error instanceof Error &&
      ['SEED_TEMPLATE_CONFLICT', 'SEED_DICTIONARY_CONFLICT'].includes(error.message)
    ) {
      await audit.recordFailureAfterRollback(client, attemptId, 'SEED_CONFLICT');
    } else {
      await audit.markUnknown(client, attemptId);
    }
    throw error;
  }
}
