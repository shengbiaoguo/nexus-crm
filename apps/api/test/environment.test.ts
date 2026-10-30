import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEnvironment } from '../src/config/environment.js';

const valid = {
  DATABASE_URL: 'mysql://nexus:test_only@127.0.0.1:3306/nexus_test',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  CORS_ORIGIN: 'http://localhost:5173',
};

test('configuration rejects invalid ports and protocols without exposing credentials', () => {
  assert.throws(() => validateEnvironment({ ...valid, API_PORT: '70000' }), /API_PORT/);
  assert.throws(
    () => validateEnvironment({ ...valid, DATABASE_URL: 'postgres://secret:private@localhost/db' }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('DATABASE_URL') &&
      !error.message.includes('secret'),
  );
  assert.throws(
    () => validateEnvironment({ ...valid, REDIS_URL: 'http://localhost' }),
    /REDIS_URL/,
  );
  assert.throws(() => validateEnvironment({ ...valid, SWAGGER_ENABLED: 'yes' }), /SWAGGER_ENABLED/);
});

test('configuration parses defaults and keeps Swagger opt-in', () => {
  const environment = validateEnvironment(valid);
  assert.equal(environment.API_PORT, 3000);
  assert.equal(environment.SWAGGER_ENABLED, false);
});
