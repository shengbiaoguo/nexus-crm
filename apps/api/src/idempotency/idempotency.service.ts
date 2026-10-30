import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { SuccessAudit } from '../audit/audit.service.js';
import type { AccessIdentity } from '../auth/auth.crypto.js';
import { unauthenticated } from '../auth/auth.crypto.js';
import { ApiException } from '../http/api.exception.js';
import type { JsonValue } from '../http/serialize-json.js';
import { IdempotencyStore } from './idempotency.store.js';
import {
  canonicalJson,
  IdempotencyResult,
  inProgress,
  prepareCommand,
  responseSnapshot,
  resultUnknown,
  userLockPlan,
} from './idempotency.contract.js';
import type { PreparedCommand, UserLock } from './idempotency.contract.js';

export const RECOVERY_CLIENT = Symbol('IDEMPOTENCY_RECOVERY_CLIENT');
type Authorize = (
  tx: Prisma.TransactionClient,
  phase: 'preflight' | 'transaction',
) => Promise<void>;
export interface IdempotentCommand {
  userLocks?: readonly UserLock[];
  identity: AccessIdentity;
  key: unknown;
  requestId: string;
  operationId: string;
  entityType: string;
  entityId: string;
  targets: Record<string, string>;
  dto: JsonValue;
  responseFields: readonly string[];
  /** Current action/object authorization only; no business version/state checks or mutations. */
  authorize: Authorize;
  /** Use this tx and the frozen normalized DTO; business/state checks occur only on first execution. */
  execute: (
    tx: Prisma.TransactionClient,
    dto: JsonValue,
  ) => Promise<{
    httpStatus: number;
    body: unknown;
    audit?: Pick<SuccessAudit, 'before' | 'after'>;
  }>;
}

function freeze(value: JsonValue): JsonValue {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function publicFailure(error: unknown, waitingForKey = false): ApiException {
  if (error instanceof ApiException) return error;
  // Error text is inspected only for classification and is never returned or logged.
  if (waitingForKey && error instanceof Error && /lock wait timeout/i.test(error.message))
    return inProgress();
  return new ApiException('SERVICE_UNAVAILABLE', 'Command could not complete; retain the same key');
}

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
    private readonly store: IdempotencyStore,
    @Inject(RECOVERY_CLIENT) private readonly recoveryClient: () => PrismaClient,
  ) {}

  async execute(input: IdempotentCommand): Promise<IdempotencyResult> {
    const dto = freeze(JSON.parse(canonicalJson(input.dto)) as JsonValue);
    const command = prepareCommand({ ...input, actorId: input.identity.sub, dto });
    input = {
      ...input,
      identity: { ...input.identity },
      userLocks: userLockPlan(input.identity.sub, input.userLocks),
    };
    if (typeof input.authorize !== 'function' || typeof input.execute !== 'function')
      throw new TypeError('Authorization and transactional execution callbacks are required');
    try {
      await this.database.client.$transaction(
        async (tx) => {
          await this.identity(tx, input.identity, false);
          await input.authorize(tx, 'preflight');
        },
        { isolationLevel: 'ReadCommitted' },
      );
    } catch (error) {
      throw publicFailure(error);
    }
    let attemptId: string;
    try {
      attemptId = await this.database.client.$transaction(
        (tx) =>
          this.store.withWaitLimit(tx, () => this.audit.startAttempt(tx, this.attempt(command))),
        { timeout: 5000, maxWait: 2000 },
      );
    } catch {
      throw new ApiException('AUDIT_UNAVAILABLE', 'Attempt prewrite unavailable');
    }
    let enteredBusiness = false;
    let readyToCommit = false;
    let keyClaimed = false;
    try {
      return await this.audit.withTransaction(
        this.database.client,
        async (tx) => {
          // Claim before business locks so same-Key contenders have a bounded unique-key wait.
          const record = await this.store.claim(tx, command);
          keyClaimed = true;
          await this.identity(tx, input.identity, true, input.userLocks);
          await input.authorize(tx, 'transaction');
          if (record) {
            const replay = this.store.replay(record, command);
            await this.replayAudit(tx, command, attemptId);
            readyToCommit = true;
            return replay;
          }
          const unresolved = await tx.commandAttempt.findFirst({
            where: {
              idempotencyScope: command.scope,
              idempotencyKey: command.key,
              attemptId: { not: attemptId },
              OR: [
                { status: 'UNKNOWN' },
                { status: 'STARTED', startedAt: { lte: new Date(Date.now() - 300000) } },
              ],
            },
            select: { id: true },
          });
          if (unresolved) throw resultUnknown();
          enteredBusiness = true;
          const outcome = await input.execute(tx, dto);
          const body = responseSnapshot(outcome.body, input.responseFields, outcome.httpStatus);
          await this.audit.recordSuccess(tx, {
            ...outcome.audit,
            ...this.context(command),
            action: command.operationId,
            attemptId,
            resultRef: this.resultRef(command),
          });
          await this.store.finish(tx, command, outcome.httpStatus, body);
          readyToCommit = true;
          return new IdempotencyResult(outcome.httpStatus, body, false);
        },
        { isolationLevel: 'ReadCommitted', timeout: 10000, maxWait: 2000 },
      );
    } catch (error) {
      if (!enteredBusiness && !readyToCommit) {
        // Only claim/authorization ran: no business callback or success could have committed.
        try {
          await this.database.client.$transaction(
            (tx) =>
              this.store.withWaitLimit(tx, () =>
                this.audit.recordFailureAfterRollback(
                  tx,
                  attemptId,
                  publicFailure(error, !keyClaimed).code,
                ),
              ),
            { timeout: 5000, maxWait: 2000 },
          );
        } catch {
          throw new ApiException('AUDIT_UNAVAILABLE', 'Attempt failure could not be persisted');
        }
        throw publicFailure(error, !keyClaimed);
      }
      return this.recover(command, input, attemptId, error);
    }
  }

  private async recover(
    command: PreparedCommand,
    input: IdempotentCommand,
    attemptId: string,
    originalError: unknown,
  ): Promise<IdempotencyResult> {
    let client: PrismaClient | undefined;
    let resolution: { replay?: IdempotencyResult; failure?: ApiException } | undefined;
    let recoveryClaimed = false;
    try {
      // A distinct client/pool is opened only for recovery and always closed afterwards.
      client = this.recoveryClient();
      resolution = await this.audit.withTransaction(
        client,
        async (tx) => {
          const record = await this.store.claim(tx, command);
          recoveryClaimed = true;
          await this.identity(tx, input.identity, true, input.userLocks);
          await input.authorize(tx, 'transaction');
          const attempt = await tx.commandAttempt.findUniqueOrThrow({ where: { attemptId } });
          if (record) {
            const replay = this.store.replay(record, command);
            if (attempt.status === 'STARTED' || attempt.status === 'UNKNOWN')
              await this.replayAudit(tx, command, attemptId);
            return { replay };
          }
          // Owning the same unique key proves the original transaction no longer holds it.
          // Never infer rollback if its committed attempt says success (e.g. a cleaned old result).
          if (attempt.status === 'SUCCEEDED' || attempt.status === 'REPLAYED')
            throw resultUnknown();
          await tx.idempotencyRecord.delete({
            where: { scope_key: { scope: command.scope, key: command.key } },
          });
          await this.audit.recordFailureAfterRollback(
            tx,
            attemptId,
            publicFailure(originalError).code,
          );
          return { failure: publicFailure(originalError) };
        },
        { isolationLevel: 'ReadCommitted', timeout: 10000, maxWait: 2000 },
      );
    } catch (error) {
      // No positive resolution: keep a durable UNKNOWN instead of claiming business failure.
      try {
        if (!client) client = this.recoveryClient();
        await client.$transaction(
          (tx) => this.store.withWaitLimit(tx, () => this.audit.markUnknown(tx, attemptId)),
          { timeout: 5000, maxWait: 2000 },
        );
      } catch {
        throw new ApiException('AUDIT_UNAVAILABLE', 'Attempt outcome could not be persisted');
      }
      if (error instanceof ApiException && error.getStatus() < 500) throw error;
      const failure = publicFailure(error, !recoveryClaimed);
      if (failure.code === 'IDEMPOTENCY_IN_PROGRESS') throw failure;
      throw resultUnknown();
    } finally {
      await client?.$disconnect();
    }
    if (resolution.replay) return resolution.replay;
    throw resolution.failure ?? resultUnknown();
  }

  private async identity(
    tx: Prisma.TransactionClient,
    identity: AccessIdentity,
    lock: boolean,
    locks: readonly UserLock[] = [{ id: identity.sub, mode: 'SHARE' }],
  ) {
    if (lock)
      for (const user of locks) {
        if (user.mode === 'UPDATE')
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${BigInt(user.id)} FOR UPDATE`;
        else await tx.$queryRaw`SELECT id FROM users WHERE id = ${BigInt(user.id)} FOR SHARE`;
      }
    const user = await tx.user.findUnique({
      where: { id: BigInt(identity.sub) },
      select: {
        status: true,
        credentialVersion: true,
        refreshSessions: {
          where: { id: BigInt(identity.sid) },
          select: { revokedAt: true, expiresAt: true },
        },
      },
    });
    const session = user?.refreshSessions[0];
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      user.credentialVersion !== identity.cv ||
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now()
    )
      throw unauthenticated();
  }
  private context(command: PreparedCommand) {
    return {
      actorId: command.actorId,
      entityType: command.entityType,
      entityId: command.entityId,
      requestId: command.requestId,
    };
  }
  private attempt(command: PreparedCommand) {
    return {
      ...this.context(command),
      operationId: command.operationId,
      idempotencyScope: command.scope,
      idempotencyKey: command.key,
      requestHash: command.requestHash,
    };
  }
  private resultRef(command: PreparedCommand) {
    return `${command.entityType}:${command.entityId}`;
  }
  private replayAudit(tx: Prisma.TransactionClient, command: PreparedCommand, attemptId: string) {
    return this.audit.recordReplay(tx, {
      ...this.context(command),
      attemptId,
      resultRef: this.resultRef(command),
    });
  }
}
