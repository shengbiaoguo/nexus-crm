import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplication } from '../src/application.js';
import { validateEnvironment } from '../src/config/environment.js';

test('health and OpenAPI work without MySQL or Redis connections', async () => {
  const environment = validateEnvironment({
    DATABASE_URL: 'mysql://unused:unused@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
    CORS_ORIGIN: 'http://localhost:5173',
    SWAGGER_ENABLED: 'true',
  });
  const { app, document } = await createApplication(environment, false);
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const response = await fetch(`${origin}/api/v1/health`, {
      headers: { 'X-Request-Id': 'untrusted-client-id' },
    });
    const body = (await response.json()) as { data: { status: string }; requestId: string };
    assert.equal(response.status, 200);
    assert.equal(body.data.status, 'ok');
    assert.match(body.requestId, /^[a-f0-9-]{36}$/);
    assert.equal(body.requestId, response.headers.get('x-request-id'));
    assert.notEqual(body.requestId, 'untrusted-client-id');
    assert.ok(document.paths['/api/v1/health']);
    assert.equal((await fetch(`${origin}/docs`)).status, 200);
    const missing = await fetch(`${origin}/api/v1/missing`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code: string }).code, 'RESOURCE_NOT_FOUND');
  } finally {
    await app.close();
  }
});
