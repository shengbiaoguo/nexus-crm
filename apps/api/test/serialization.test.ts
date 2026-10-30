import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializeJson } from '../src/http/serialize-json.js';

test('JSON conversion preserves large IDs, UTC milliseconds, nested values and null', () => {
  assert.deepEqual(
    serializeJson({
      id: 18446744073709551615n,
      at: new Date('2026-10-30T10:20:30.123+08:00'),
      nested: [1n, null],
    }),
    { id: '18446744073709551615', at: '2026-10-30T02:20:30.123Z', nested: ['1', null] },
  );
  for (const invalid of [
    undefined,
    Number.NaN,
    new Date('invalid'),
    new Map(),
    { unsupported: undefined },
  ])
    assert.throws(() => serializeJson(invalid), TypeError);
});
