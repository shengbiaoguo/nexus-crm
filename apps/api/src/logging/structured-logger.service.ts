import { Injectable } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import { z } from 'zod';

const fieldsSchema = z
  .object({
    requestId: z.uuid().optional(),
    attemptId: z.uuid().optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
    status: z.number().int().min(100).max(599).optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
      .optional(),
  })
  .partial();
type Fields = z.infer<typeof fieldsSchema>;
const levelSchema = z.enum(['info', 'warn', 'error', 'debug']);
const eventSchema = z.enum([
  'http_request',
  'request_failed',
  'audit_unavailable',
  'attempt_unknown',
  'startup_failed',
  'nest_log',
]);
type Level = z.infer<typeof levelSchema>;
type Event = z.infer<typeof eventSchema>;

@Injectable()
export class StructuredLogger implements LoggerService {
  private enabled = true;
  constructor(
    private readonly sink: (line: string) => void = (line) => {
      console.log(line);
    },
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  event(
    level: Level,
    event: Event,
    fields: Omit<Fields, 'method'> & { method?: string } = {},
  ): void {
    if (!this.enabled) return;
    // Runtime whitelist as well as TS types: request bodies/Error objects never become log payloads.
    try {
      if (!levelSchema.safeParse(level).success || !eventSchema.safeParse(event).success) return;
      const component =
        event === 'http_request' || event === 'request_failed'
          ? 'http'
          : event === 'audit_unavailable' || event === 'attempt_unknown'
            ? 'audit'
            : event === 'startup_failed'
              ? 'bootstrap'
              : 'nest';
      const safeFields: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(fieldsSchema.shape)) {
        const parsed = schema.safeParse((fields as Record<string, unknown>)[key]);
        if (parsed.success && parsed.data !== undefined) safeFields[key] = parsed.data;
      }
      this.sink(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          event,
          component,
          ...safeFields,
        }),
      );
    } catch {
      /* Operational logging is best effort; it never commits or rejects business work. */
    }
  }

  // Nest may pass arbitrary exceptions, SQL or free text. Do not log these arguments.
  log(...args: unknown[]): void {
    void args;
    this.event('info', 'nest_log');
  }
  error(...args: unknown[]): void {
    void args;
    this.event('error', 'nest_log');
  }
  warn(...args: unknown[]): void {
    void args;
    this.event('warn', 'nest_log');
  }
  debug(...args: unknown[]): void {
    void args;
    this.event('debug', 'nest_log');
  }
  verbose(...args: unknown[]): void {
    void args;
    this.event('debug', 'nest_log');
  }
  fatal(...args: unknown[]): void {
    void args;
    this.event('error', 'nest_log');
  }
}
