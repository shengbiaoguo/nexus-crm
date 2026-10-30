import { HttpException } from '@nestjs/common';
import type { JsonValue } from './serialize-json.js';

// API contract §1.4. Status belongs to the code, not to individual callers.
const errorStatuses = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  PERMISSION_DENIED: 403,
  SELF_APPROVAL_FORBIDDEN: 403,
  RESOURCE_NOT_FOUND: 404,
  ORDER_STATE_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  BUSINESS_RULE_VIOLATION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  DELIVERY_ALREADY_STARTED: 409,
  DELIVERY_NOT_ACCEPTED: 409,
  BLOCKING_APPLICATION_EXISTS: 409,
  PAYMENT_ALREADY_REVERSED: 409,
  CUSTOMER_CREDIT_CODE_EXISTS: 409,
  PAYMENT_AMOUNT_INVALID: 422,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  AUDIT_UNAVAILABLE: 503,
  IDEMPOTENCY_RESULT_UNKNOWN: 503,
} as const;

export type ApiErrorCode = keyof typeof errorStatuses;

/** Only explicitly public messages and authorized, selected details may be passed here. */
export class ApiException extends HttpException {
  constructor(
    readonly code: ApiErrorCode,
    readonly publicMessage: string,
    readonly details?: JsonValue,
  ) {
    super(publicMessage, errorStatuses[code]);
  }
}
