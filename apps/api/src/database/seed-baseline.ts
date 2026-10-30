import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { grantSignature, permissionCodes, roleDefinitions } from './seed-data.js';

export async function seedBaseline(client: PrismaClient): Promise<{ created: boolean }> {
  // Preflight is repeated under SERIALIZABLE; changed templates are never silently restored.
  const attemptId = randomUUID();
  await client.commandAttempt.create({
    data: {
      attemptId,
      systemActor: 'seed:m0',
      operationId: 'seedM0Baseline',
      entityType: 'permission_dictionary',
      entityId: 'm0-v1',
      requestId: attemptId,
      idempotencyScope: 'system:seed:m0',
      idempotencyKey: randomUUID(),
      requestHash: createHash('sha256').update(JSON.stringify(roleDefinitions)).digest('hex'),
    },
  });
  let callbackCompleted = false;
  try {
    return await client.$transaction(
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
          await tx.auditLog.create({
            data: {
              systemActor: 'seed:m0',
              action: 'm0.baseline_initialized',
              entityType: 'permission_dictionary',
              entityId: 'm0-v1',
              requestId: attemptId,
              attemptId,
              afterJson: {
                roles: roleDefinitions.map((role) => role.code),
                permissionCount: permissionCodes.length,
              },
            },
          });
        }
        await tx.commandAttempt.update({
          where: { attemptId },
          data: {
            status: changed ? 'SUCCEEDED' : 'REPLAYED',
            finishedAt: new Date(),
            resultRef: 'permission_dictionary:m0-v1',
          },
        });
        callbackCompleted = true;
        return { created: changed };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 },
    );
  } catch (error) {
    await client.commandAttempt.updateMany({
      where: { attemptId, status: { in: ['STARTED', 'UNKNOWN'] } },
      data: {
        status: callbackCompleted ? 'UNKNOWN' : 'FAILED',
        finishedAt: new Date(),
        errorCode: callbackCompleted ? 'SEED_COMMIT_UNKNOWN' : 'SEED_CONFLICT_OR_FAILURE',
      },
    });
    throw error;
  }
}
