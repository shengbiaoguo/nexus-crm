import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';

// Reserve a free port, then start the compiled entrypoint as a real process.
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const address = reservation.address();
assert.ok(address && typeof address === 'object');
const port = address.port;
await new Promise((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);
const child = spawn(process.execPath, ['apps/api/dist/main.js'], {
  cwd: new URL('../', import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    CORS_ORIGIN: 'http://localhost:5173',
    SWAGGER_ENABLED: 'true',
    DATABASE_URL: 'mysql://unused:unused@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (chunk) => {
  logs += chunk;
});
child.stderr.on('data', (chunk) => {
  logs += chunk;
});
let processError;
child.on('error', (error) => {
  processError = error;
});
const base = `http://127.0.0.1:${port}`;
try {
  let response;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (processError) throw processError;
    if (child.exitCode !== null) throw new Error(`API exited ${child.exitCode}: ${logs}`);
    try {
      response = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
      break;
    } catch {
      await setTimeout(150);
    }
  }
  assert.ok(response, `API did not start: ${logs}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.status, 'ok');
  assert.match(body.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(response.headers.get('x-request-id'), body.requestId);
  assert.equal((await fetch(`${base}/docs`)).status, 200);
  const schema = await (await fetch(`${base}/docs-json`)).json();
  assert.equal(schema.paths['/api/v1/health'].get.operationId, 'getHealth');
  console.log(
    'PASS compiled API: GET /api/v1/health 200, /docs 200, OpenAPI health contract valid; no DB/Redis connection required.',
  );
} finally {
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
}
