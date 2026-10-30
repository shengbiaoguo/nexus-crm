import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { IdempotencyRecord } from '../generated/prisma/client.js';
import { ApiException } from '../http/api.exception.js';
import {
  inProgress,
  resultUnknown,
  IdempotencyResult,
  responseSnapshot,
} from './idempotency.contract.js';
import type { PreparedCommand, Summary } from './idempotency.contract.js';

function duplicate(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class IdempotencyStore {
  async withWaitLimit<T>(tx: Prisma.TransactionClient, work: () => Promise<T>): Promise<T> {
    const setting = await tx.$queryRaw<
      { seconds: number | bigint }[]
    >`SELECT @@session.innodb_lock_wait_timeout AS seconds`;
    const previous = Number(setting[0]?.seconds);
    if (!Number.isSafeInteger(previous) || previous < 1)
      throw new Error('Invalid MySQL lock wait configuration');
    await tx.$executeRaw`SET SESSION innodb_lock_wait_timeout = 2`;
    try {
      return await work();
    } finally {
      await tx.$executeRaw`SET SESSION innodb_lock_wait_timeout = ${previous}`;
    }
  }

  async claim(
    tx: Prisma.TransactionClient,
    command: PreparedCommand,
  ): Promise<IdempotencyRecord | null> {
    return this.withWaitLimit(tx, async () => {
      try {
        await tx.idempotencyRecord.create({
          data: {
            scope: command.scope,
            key: command.key,
            requestHash: command.requestHash,
            fingerprintVersion: 1,
            status: 'PROCESSING',
            expiresAt: new Date(),
          },
        });
        return null;
      } catch (error) {
        if (!duplicate(error)) throw error;
        const record = await tx.idempotencyRecord.findUnique({
          where: { scope_key: { scope: command.scope, key: command.key } },
        });
        if (!record) throw resultUnknown();
        return record;
      }
    });
  }

  replay(record: IdempotencyRecord, command: PreparedCommand): IdempotencyResult {
    if (record.requestHash !== command.requestHash || record.fingerprintVersion !== 1)
      throw new ApiException(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency key was used for a different request',
      );
    if (record.status !== 'COMPLETED') throw inProgress();
    if (
      record.httpStatus === null ||
      ![200, 201, 204].includes(record.httpStatus) ||
      !record.completedAt
    )
      throw resultUnknown();
    try {
      const body = responseSnapshot(
        record.responseBody,
        record.responseBody && typeof record.responseBody === 'object'
          ? Object.keys(record.responseBody)
          : [],
        record.httpStatus,
      );
      return new IdempotencyResult(record.httpStatus, body, true);
    } catch {
      throw resultUnknown();
    }
  }

  async finish(
    tx: Prisma.TransactionClient,
    command: PreparedCommand,
    status: number,
    body: Summary | null,
  ) {
    // Final database-time update, with one extra day beyond the minimum 7-day promise.
    const updated =
      await tx.$executeRaw`UPDATE idempotency_records SET status = 'COMPLETED', http_status = ${status},
      response_body = ${JSON.stringify(body)}, completed_at = UTC_TIMESTAMP(3),
      expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 8 DAY)
      WHERE scope = ${command.scope} AND \`key\` = ${command.key} AND status = 'PROCESSING'`;
    if (updated !== 1) throw resultUnknown();
  }
}
