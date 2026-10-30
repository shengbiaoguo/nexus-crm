import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client.js';
import { IdempotencyStore } from '../idempotency/idempotency.store.js';
import { z } from 'zod';
import { responseSnapshot } from '../idempotency/idempotency.contract.js';

@Injectable()
export class AttemptReconciliationService {
  constructor(private readonly store: IdempotencyStore) {}

  /** Bounded cursor batch. Reconciles attempt evidence, never reruns business or deletes records. */
  async runBatch(
    client: PrismaClient,
    afterId = 0n,
    now = new Date(),
    attemptIds?: readonly string[],
  ) {
    if (afterId < 0n || !Number.isFinite(now.getTime()))
      throw new TypeError('Invalid reconciliation cursor/time');
    if (attemptIds !== undefined) z.array(z.uuid()).max(100).parse(attemptIds);
    const cutoff = new Date(now.getTime() - 300000);
    const candidates = await client.commandAttempt.findMany({
      where: {
        id: { gt: afterId },
        ...(attemptIds === undefined ? {} : { attemptId: { in: [...attemptIds] } }),
        OR: [{ status: 'UNKNOWN' }, { status: 'STARTED', startedAt: { lte: cutoff } }],
      },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true },
    });
    let confirmed = 0;
    let unknown = 0;
    for (const { id } of candidates) {
      const result = await client.$transaction(
        (tx) =>
          this.store.withWaitLimit(tx, async () => {
            await tx.$queryRaw`SELECT id FROM command_attempts WHERE id = ${id} FOR UPDATE`;
            const attempt = await tx.commandAttempt.findUniqueOrThrow({ where: { id } });
            if (
              attempt.status !== 'UNKNOWN' &&
              (attempt.status !== 'STARTED' || attempt.startedAt > cutoff)
            )
              return 'unchanged';
            const record = await tx.idempotencyRecord.findUnique({
              where: {
                scope_key: { scope: attempt.idempotencyScope, key: attempt.idempotencyKey },
              },
            });
            const audits = await tx.auditLog.findMany({
              where: {
                attemptId: attempt.attemptId,
                actorId: attempt.actorId,
                systemActor: attempt.systemActor,
                requestId: attempt.requestId,
                action: attempt.operationId,
              },
              select: { entityType: true, entityId: true },
            });
            const matchingAudit = audits.some(
              (audit) =>
                audit.entityType === attempt.entityType &&
                (attempt.entityId === 'new'
                  ? record?.responseBody !== null &&
                    typeof record?.responseBody === 'object' &&
                    !Array.isArray(record.responseBody) &&
                    record.responseBody.id === audit.entityId
                  : audit.entityId === attempt.entityId) &&
                `${audit.entityType}:${audit.entityId}` === attempt.resultRef,
            );
            let validResult = false;
            if (
              record?.httpStatus !== null &&
              record?.httpStatus !== undefined &&
              [200, 201, 204].includes(record.httpStatus)
            ) {
              try {
                responseSnapshot(
                  record.responseBody,
                  record.responseBody && typeof record.responseBody === 'object'
                    ? Object.keys(record.responseBody)
                    : [],
                  record.httpStatus,
                );
                validResult = true;
              } catch {
                /* Invalid persisted summaries are not success evidence. */
              }
            }
            if (
              record?.status === 'COMPLETED' &&
              record.completedAt &&
              record.requestHash === attempt.requestHash &&
              record.fingerprintVersion === 1 &&
              validResult &&
              matchingAudit
            ) {
              await tx.commandAttempt.update({
                where: { id },
                data: { status: 'SUCCEEDED', finishedAt: record.completedAt, errorCode: null },
              });
              return 'confirmed';
            }
            // Missing/cleaned results or a result belonging to a different attempt is not proof of failure/success.
            await tx.commandAttempt.update({
              where: { id },
              data: {
                status: 'UNKNOWN',
                finishedAt: null,
                errorCode: 'ATTEMPT_REQUIRES_VERIFICATION',
              },
            });
            return 'unknown';
          }),
        { isolationLevel: 'ReadCommitted', timeout: 5000, maxWait: 2000 },
      );
      if (result === 'confirmed') confirmed++;
      if (result === 'unknown') unknown++;
    }
    return {
      examined: candidates.length,
      confirmed,
      unknown,
      nextCursor: candidates.length ? String(candidates.at(-1)!.id) : null,
    };
  }
}
