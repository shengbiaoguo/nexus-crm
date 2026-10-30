import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHealthyResponse } from '../src/health.mjs';

test('accept only the public health envelope, not an arbitrary HTTP 200 body', () => {
  assert.equal(isHealthyResponse({ data: { status: 'ok' }, requestId: 'test' }), true);
  for (const invalid of [
    null,
    {},
    { status: 'ok' },
    { data: { status: 'down' }, requestId: 'test' },
    { data: { status: 'ok' } },
  ]) {
    assert.equal(isHealthyResponse(invalid), false);
  }
});
