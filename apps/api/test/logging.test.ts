import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { auditSnapshot, REDACTED } from '../src/logging/redact.js';
import { StructuredLogger } from '../src/logging/structured-logger.service.js';

test('audit snapshots use nested field whitelists and redact credentials, tokens and contact/bank data', () => {
  const original = {
    status: 'ACTIVE',
    password: 'never-store-password',
    nested: {
      version: 2,
      access_token: 'never-store-token',
      email: 'private@example.com',
      hidden: 'never-store-hidden',
    },
    items: [{ status: 'ok', bankAccount: '6222021234567890123', hidden: 'never-store-hidden' }],
    note: 'Bearer never-store-bearer private@example.com 13800138000 mysql://user:pass@localhost/db',
    secret: 'never-store-secret',
  };
  const result = auditSnapshot(original, [
    'status',
    'password',
    'nested.version',
    'nested.access_token',
    'nested.email',
    'items.status',
    'items.bankAccount',
    'note',
  ]);
  assert.deepEqual(result, {
    status: 'ACTIVE',
    password: REDACTED,
    nested: { version: 2, access_token: REDACTED, email: REDACTED },
    items: [{ status: 'ok', bankAccount: REDACTED }],
    note: `${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED}`,
  });
  assert.equal(original.password, 'never-store-password');
  assert.deepEqual(auditSnapshot({ nested: original.nested }, ['nested']), { nested: {} });
  assert.throws(() => auditSnapshot(original, []), /explicit/);
  assert.throws(() => auditSnapshot({ note: 'x'.repeat(17000) }, ['note']), /16 KiB/);
  assert.throws(() => auditSnapshot({ value: Number.NaN }, ['value']), TypeError);
});

test('structured operational logs are JSON, bounded to metadata and discard arbitrary payloads and Nest errors', () => {
  const lines: string[] = [];
  const logger = new StructuredLogger((line) => lines.push(line));
  const requestId = randomUUID();
  const fields = {
    requestId,
    method: 'POST',
    status: 400,
    durationMs: 1,
    password: 'secret-password',
    token: 'secret-token',
    headers: { authorization: 'Bearer secret' },
    body: { bankCard: '6222021234567890123' },
    query: 'private@example.com',
    message: 'SQL secret',
  };
  logger.event('info', 'http_request', fields);
  logger.error(new Error('mysql://user:password@localhost/db'), 'SQL secret');
  logger.warn({ token: 'secret-token' });
  logger.event('error', 'request_failed', { requestId: 'secret-token', code: 'SQL secret' });
  assert.equal(lines.length, 4);
  const first = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(first.requestId, requestId);
  assert.equal(first.event, 'http_request');
  assert.equal(first.level, 'info');
  assert.equal(new Date(String(first.timestamp)).toISOString(), first.timestamp);
  assert.doesNotMatch(
    lines.join('\n'),
    /secret|password|authorization|622202|example.com|mysql|SQL/,
  );
  logger.setEnabled(false);
  logger.event('error', 'startup_failed');
  assert.equal(lines.length, 4);
  assert.doesNotThrow(() =>
    new StructuredLogger(() => {
      throw new Error('sink failure');
    }).event('error', 'startup_failed'),
  );
});
