import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiException } from '../http/api.exception.js';
import type { JsonValue } from '../http/serialize-json.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/);
const userId = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((value) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n);
const metadata = z.object({
  actorId: userId,
  key: z.uuid().transform((value) => value.toLowerCase()),
  requestId: z.uuid(),
  operationId: identifier,
  entityType: identifier.max(64),
  entityId: identifier,
});

/** JSON only: caller normalizes DTO defaults, Decimal strings, ID strings and UTC dates first. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 20) throw new TypeError('Idempotency JSON exceeds maximum depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (
      Object.keys(value).length !== value.length ||
      Object.keys(value).some((key, index) => key !== String(index))
    )
      throw new TypeError('Sparse or decorated arrays are not JSON');
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Symbols are not JSON');
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) throw new TypeError('Accessors are not JSON');
        return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1)}`;
      })
      .join(',')}}`;
  }
  throw new TypeError('Normalize the DTO to explicit JSON values before fingerprinting');
}

export interface CommandMetadata {
  actorId: string;
  key: unknown;
  requestId: string;
  operationId: string;
  entityType: string;
  entityId: string;
  targets: Record<string, string>;
  dto: JsonValue;
}

export function prepareCommand(input: CommandMetadata) {
  const parsed = metadata.safeParse(input);
  if (!parsed.success)
    throw new ApiException('VALIDATION_FAILED', 'Invalid idempotency metadata or key');
  if (
    !input.targets ||
    Object.getPrototypeOf(input.targets) !== Object.prototype ||
    Object.values(input.targets).some((value) => typeof value !== 'string')
  )
    throw new TypeError('Targets must contain all normalized route IDs as strings');
  const fingerprint = canonicalJson({
    apiVersion: 'v1',
    operationId: parsed.data.operationId,
    entity: { type: parsed.data.entityType, id: parsed.data.entityId },
    targets: input.targets,
    dto: input.dto,
  });
  if (Buffer.byteLength(fingerprint) > 1024 * 1024)
    throw new ApiException('VALIDATION_FAILED', 'Idempotency input too large');
  return {
    ...parsed.data,
    scope: `user:${parsed.data.actorId}`,
    requestHash: createHash('sha256').update(fingerprint, 'utf8').digest('hex'),
    fingerprintVersion: 1,
  };
}
export type PreparedCommand = ReturnType<typeof prepareCommand>;

export interface UserLock {
  id: string;
  mode: 'SHARE' | 'UPDATE';
}
/** Caller supplies the complete related-user set; lock once in numeric ID order before roles. */
export function userLockPlan(actorId: string, requested: readonly UserLock[] = []): UserLock[] {
  const locks = z
    .array(z.object({ id: userId, mode: z.enum(['SHARE', 'UPDATE']) }))
    .max(100)
    .parse(requested);
  const modes = new Map<string, UserLock['mode']>([[userId.parse(actorId), 'SHARE']]);
  for (const lock of locks) {
    if (modes.get(lock.id) !== 'UPDATE') modes.set(lock.id, lock.mode);
  }
  return [...modes]
    .map(([id, mode]) => ({ id, mode }))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

export type Summary = Record<string, string | number | boolean | null>;
/** The creation adapter accepts only a real canonical unsigned ID in a 201 snapshot. */
export function creationResultId(status: number, body: Summary | null): string {
  const id = body?.['id'];
  if (
    status !== 201 ||
    typeof id !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(id) ||
    BigInt(id) > 18446744073709551615n
  )
    throw new TypeError('Creation requires 201 and a canonical unsigned ID');
  return id;
}
const sensitive =
  /password|secret|token|credential|cookie|authorization|bank|phone|email|contact|address|payload|requestbody/i;

/** Explicit server-owned scalar field projection; never persist a full HTTP response or envelope. */
export function responseSnapshot(
  body: unknown,
  fields: readonly string[],
  status: number,
): Summary | null {
  if (![200, 201, 204].includes(status))
    throw new TypeError('Only synchronous command success statuses can be stored');
  if (status === 204) {
    if (body !== null) throw new TypeError('204 commands require null body');
    return null;
  }
  if (
    !fields.length ||
    fields.some((field) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(field) || sensitive.test(field))
  )
    throw new TypeError('Response snapshot requires safe explicit summary fields');
  if (!body || Object.getPrototypeOf(body) !== Object.prototype)
    throw new TypeError('Response summary must be an object');
  const projected: Summary = {};
  for (const field of fields) {
    if (!Object.hasOwn(body, field)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(body, field)!;
    if (!('value' in descriptor)) throw new TypeError('Response summary cannot contain accessors');
    const value: unknown = descriptor.value;
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      throw new TypeError('Response summary fields must be JSON scalars');
    projected[field] = value as Summary[string];
  }
  if (Buffer.byteLength(JSON.stringify(projected)) > 64 * 1024)
    throw new TypeError('Response snapshot exceeds 64 KiB');
  return projected;
}

export class IdempotencyResult {
  constructor(
    readonly httpStatus: number,
    readonly body: Summary | null,
    readonly replayed: boolean,
  ) {}
}
export const inProgress = () =>
  new ApiException(
    'IDEMPOTENCY_IN_PROGRESS',
    'Command is still in progress; retry with the same key',
  );
export const resultUnknown = () =>
  new ApiException('IDEMPOTENCY_RESULT_UNKNOWN', 'Command result is unknown; retain the same key');
