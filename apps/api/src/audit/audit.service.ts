import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { ApiException } from '../http/api.exception.js';
import { auditSnapshot } from '../logging/redact.js';
import { StructuredLogger } from '../logging/structured-logger.service.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/);
const actorId = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((value) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n);
const contextSchema = z
  .object({
    actorId: actorId.optional(),
    systemActor: identifier.optional(),
    entityType: identifier.max(64),
    entityId: identifier,
    requestId: z.uuid(),
  })
  .refine((value) => (value.actorId !== undefined) !== (value.systemActor !== undefined));
export type AuditContext = z.infer<typeof contextSchema>;
export interface Snapshot {
  value: unknown;
  fields: readonly string[];
}
export interface SuccessAudit extends AuditContext {
  action: string;
  attemptId?: string;
  before?: Snapshot;
  after?: Snapshot;
  resultRef?: string;
}
export interface AttemptInput extends AuditContext {
  operationId: string;
  idempotencyScope: string;
  idempotencyKey: string;
  requestHash: string;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TypeError('Invalid audit metadata');
  return parsed.data;
}
function actor(context: AuditContext) {
  return {
    actorId: context.actorId === undefined ? null : BigInt(context.actorId),
    systemActor: context.systemActor ?? null,
  };
}
function json(snapshot: Snapshot | undefined) {
  if (snapshot === undefined) return Prisma.DbNull;
  const value = auditSnapshot(snapshot.value, snapshot.fields);
  return value === null ? Prisma.JsonNull : value;
}

@Injectable()
export class AuditService {
  private readonly transactions = new WeakSet<object>();
  private readonly failedTransactions = new WeakSet<object>();
  constructor(private readonly logger: StructuredLogger) {}

  /** Registers the exact interactive tx; Prisma 7 also exposes $transaction on transaction clients. */
  async withTransaction<T>(
    client: PrismaClient,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      maxWait?: number;
      timeout?: number;
    },
  ): Promise<T> {
    return client.$transaction(async (tx) => {
      this.transactions.add(tx);
      try {
        const result = await work(tx);
        if (this.failedTransactions.has(tx)) throw this.unavailable();
        return result;
      } finally {
        this.transactions.delete(tx);
        this.failedTransactions.delete(tx);
      }
    }, options);
  }

  /** After authentication/DTO/authorization, use root client or independent short prewrite tx, never the business tx. */
  async startAttempt(
    client: Pick<PrismaClient, 'commandAttempt'>,
    input: AttemptInput,
  ): Promise<string> {
    if (this.transactions.has(client))
      throw new TypeError('Attempt prewrite requires an independent root client');
    const context = parse(contextSchema, input);
    const operationId = parse(identifier, input.operationId);
    const scope = parse(z.string().max(64), input.idempotencyScope);
    if (scope !== (context.actorId ? `user:${context.actorId}` : `system:${context.systemActor}`)) {
      throw new TypeError('Attempt scope does not match actor');
    }
    const key = parse(z.uuid().toLowerCase(), input.idempotencyKey);
    const requestHash = parse(z.string().regex(/^[a-f0-9]{64}$/), input.requestHash);
    const attemptId = randomUUID();
    try {
      await client.commandAttempt.create({
        data: {
          ...context,
          ...actor(context),
          operationId,
          attemptId,
          idempotencyScope: scope,
          idempotencyKey: key,
          requestHash,
        },
      });
      return attemptId;
    } catch {
      throw this.unavailable(context.requestId, attemptId);
    }
  }

  /** Caller must abort the transaction on error. Business writes and idempotency result use this same tx. */
  async recordSuccess(tx: Prisma.TransactionClient, input: SuccessAudit): Promise<string> {
    this.transactionOnly(tx);
    try {
      return await this.writeSuccess(tx, input);
    } catch (error) {
      this.failedTransactions.add(tx);
      throw error;
    }
  }

  private async writeSuccess(tx: Prisma.TransactionClient, input: SuccessAudit): Promise<string> {
    const context = parse(contextSchema, input);
    const action = parse(identifier, input.action);
    const attemptId = input.attemptId === undefined ? undefined : parse(z.uuid(), input.attemptId);
    const resultRef = this.resultRef(input.resultRef);
    const beforeJson = json(input.before);
    const afterJson = json(input.after);
    try {
      if (attemptId !== undefined) {
        const updated = await tx.commandAttempt.updateMany({
          where: {
            attemptId,
            ...context,
            ...actor(context),
            status: { in: ['STARTED', 'UNKNOWN'] },
          },
          data: {
            status: 'SUCCEEDED',
            finishedAt: new Date(),
            errorCode: null,
            resultRef: resultRef ?? null,
          },
        });
        if (updated.count !== 1) throw new Error('Attempt context or state mismatch');
      }
      const audit = await tx.auditLog.create({
        data: {
          ...context,
          ...actor(context),
          action,
          attemptId: attemptId ?? null,
          beforeJson,
          afterJson,
        },
      });
      return audit.id.toString();
    } catch {
      throw this.unavailable(context.requestId, attemptId);
    }
  }

  /** A replay writes no new success audit. Caller must first verify current authorization and the stored result. */
  async recordReplay(
    tx: Prisma.TransactionClient,
    input: AuditContext & { attemptId: string; resultRef: string },
  ): Promise<void> {
    this.transactionOnly(tx);
    try {
      await this.writeReplay(tx, input);
    } catch (error) {
      this.failedTransactions.add(tx);
      throw error;
    }
  }

  private async writeReplay(
    tx: Prisma.TransactionClient,
    input: AuditContext & { attemptId: string; resultRef: string },
  ): Promise<void> {
    const context = parse(contextSchema, input);
    const attemptId = parse(z.uuid(), input.attemptId);
    const resultRef = this.resultRef(input.resultRef);
    try {
      const updated = await tx.commandAttempt.updateMany({
        where: { attemptId, ...context, ...actor(context), status: { in: ['STARTED', 'UNKNOWN'] } },
        data: {
          status: 'REPLAYED',
          finishedAt: new Date(),
          errorCode: null,
          resultRef: resultRef ?? null,
        },
      });
      if (updated.count !== 1) throw new Error('Attempt context or state mismatch');
    } catch {
      throw this.unavailable(context.requestId, attemptId);
    }
  }

  /** Only for a positively confirmed rollback; never classify a connection failure as rollback. */
  async recordFailureAfterRollback(
    client: Pick<PrismaClient, 'commandAttempt'>,
    attemptId: string,
    errorCode: string,
  ): Promise<void> {
    parse(z.uuid(), attemptId);
    parse(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/), errorCode);
    try {
      const updated = await client.commandAttempt.updateMany({
        where: { attemptId, status: { in: ['STARTED', 'UNKNOWN'] } },
        data: { status: 'FAILED', errorCode, finishedAt: new Date() },
      });
      if (updated.count !== 1) throw new Error('Attempt state mismatch');
    } catch {
      throw this.unavailable(undefined, attemptId);
    }
  }

  /** Safe on uncertain commit: conditional update cannot overwrite an already committed success. */
  async markUnknown(
    client: Pick<PrismaClient, 'commandAttempt'>,
    attemptId: string,
  ): Promise<void> {
    parse(z.uuid(), attemptId);
    try {
      const updated = await client.commandAttempt.updateMany({
        where: { attemptId, status: 'STARTED' },
        data: { status: 'UNKNOWN', errorCode: 'COMMIT_OUTCOME_UNKNOWN', finishedAt: null },
      });
      if (updated.count === 1) this.logger.event('warn', 'attempt_unknown', { attemptId });
    } catch {
      throw this.unavailable(undefined, attemptId);
    }
  }

  /** Explicit recovery entrypoint, one bounded batch. No HTTP bootstrap timer or automatic business retry. */
  async markOverdueUnknown(
    client: PrismaClient,
    now = new Date(),
    attemptIds?: readonly string[],
  ): Promise<number> {
    parse(z.date(), now);
    if (attemptIds !== undefined) parse(z.array(z.uuid()).max(100), attemptIds);
    const cutoff = new Date(now.getTime() - 5 * 60 * 1000);
    try {
      const pending = await client.commandAttempt.findMany({
        where: {
          status: 'STARTED',
          startedAt: { lte: cutoff },
          ...(attemptIds === undefined ? {} : { attemptId: { in: [...attemptIds] } }),
        },
        select: { attemptId: true },
        orderBy: { id: 'asc' },
        take: 100,
      });
      if (!pending.length) return 0;
      let count = 0;
      for (const item of pending) {
        const updated = await client.commandAttempt.updateMany({
          where: { attemptId: item.attemptId, status: 'STARTED', startedAt: { lte: cutoff } },
          data: { status: 'UNKNOWN', errorCode: 'ATTEMPT_TIMED_OUT', finishedAt: null },
        });
        count += updated.count;
        if (updated.count === 1) this.logger.event('warn', 'attempt_unknown', item);
      }
      return count;
    } catch {
      throw this.unavailable();
    }
  }

  private resultRef(value: string | undefined): string | undefined {
    return value === undefined
      ? undefined
      : parse(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,254}$/), value);
  }

  private transactionOnly(tx: Prisma.TransactionClient): void {
    if (!this.transactions.has(tx))
      throw new TypeError(
        'Success audit requires an interactive transaction registered with withTransaction',
      );
  }

  private unavailable(requestId?: string, attemptId?: string): ApiException {
    this.logger.event('error', 'audit_unavailable', {
      requestId,
      attemptId,
      code: 'AUDIT_UNAVAILABLE',
    });
    return new ApiException('AUDIT_UNAVAILABLE', 'Audit persistence unavailable');
  }
}
