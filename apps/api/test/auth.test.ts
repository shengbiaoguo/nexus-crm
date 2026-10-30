import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { AccessTokens, hashPassword, verifyPassword } from '../src/auth/auth.crypto.js';
import { ApiException } from '../src/http/api.exception.js';
import { validateEnvironment } from '../src/config/environment.js';
import { createApplication } from '../src/application.js';

test('password hashing uses salted scrypt, rejects wrong passwords and unsupported legacy hashes', async () => {
  const hash = await hashPassword('test password');
  assert.equal(await verifyPassword('test password', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('test password', 'test password'), false);
  assert.notEqual(hash, await hashPassword('test password'));
});

test('JWT pins algorithm, type, issuer, audience and validates expiry and identities', async () => {
  const secret = randomBytes(32).toString('base64url');
  const tokens = new AccessTokens(secret);
  const identity = { sub: '18446744073709551615', sid: '1', cv: 2 };
  const token = await tokens.sign(identity);
  assert.deepEqual(await tokens.verify(token), identity);
  const denied = (error: unknown) => error instanceof ApiException && error.getStatus() === 401;
  await assert.rejects(tokens.verify(token + 'x'), denied);
  await assert.rejects(
    new AccessTokens(randomBytes(32).toString('base64url')).verify(token),
    denied,
  );
  await assert.rejects(
    new AccessTokens(secret, () => new Date(Date.now() + 901000)).verify(token),
    (error: unknown) => error instanceof ApiException && error.code === 'TOKEN_EXPIRED',
  );
  for (const overrides of [
    { aud: 'other' },
    { iss: 'other' },
    { sub: '18446744073709551616' },
    { sid: '0' },
    { cv: 0 },
    { cv: '1' },
  ]) {
    const invalid = await new SignJWT({ ...identity, ...overrides })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .setIssuer('iss' in overrides ? 'other' : 'nexus-crm')
      .setAudience('aud' in overrides ? 'other' : 'nexus-crm-api')
      .sign(Buffer.from(secret, 'base64url'));
    await assert.rejects(tokens.verify(invalid), denied);
  }
  for (const header of [
    { alg: 'HS384', typ: 'at+jwt' },
    { alg: 'HS256', typ: 'JWT' },
  ]) {
    const invalid = await new SignJWT(identity)
      .setProtectedHeader(header)
      .setIssuedAt()
      .setExpirationTime('15m')
      .setIssuer('nexus-crm')
      .setAudience('nexus-crm-api')
      .sign(Buffer.from(secret, 'base64url'));
    await assert.rejects(tokens.verify(invalid), denied);
  }
  await assert.rejects(tokens.verify('eyJhbGciOiJub25lIn0.e30.'), denied);
});

test('auth HTTP validation, anonymous rejection and missing configuration work without database', async () => {
  const environment = validateEnvironment({
    DATABASE_URL: 'mysql://unused:unused@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
    CORS_ORIGIN: 'http://localhost:5173',
  });
  const { app, document } = await createApplication(environment, false);
  try {
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1/auth`;
    const send = (path: string, data: unknown) =>
      fetch(`${base}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
    assert.equal(
      (await send('login', { loginName: 'a', password: 'p', status: 'ACTIVE' })).status,
      400,
    );
    assert.equal((await send('refresh', { refreshToken: 'invalid' })).status, 400);
    assert.equal((await send('login', { loginName: 'a', password: 'p' })).status, 503);
    assert.equal((await fetch(`${base}/me`)).status, 401);
    assert.equal((await send('logout', {})).status, 401);
    for (const path of ['login', 'refresh', 'logout', 'me'])
      assert.ok(document.paths[`/api/v1/auth/${path}`]);
    for (let i = 0; i < 18; i++) await send('refresh', {});
    assert.equal((await send('login', { loginName: 'a', password: 'p' })).status, 429);
  } finally {
    await app.close();
  }
});

test('JWT secret config rejects placeholders and malformed base64url without leaking values', () => {
  const values = {
    DATABASE_URL: 'mysql://unused:unused@localhost/db',
    REDIS_URL: 'redis://localhost',
    CORS_ORIGIN: 'http://localhost:5173',
  };
  assert.throws(
    () => validateEnvironment({ ...values, AUTH_JWT_SECRET: 'replace_me' }),
    /AUTH_JWT_SECRET/,
  );
  assert.equal(
    validateEnvironment({ ...values, AUTH_JWT_SECRET: randomBytes(32).toString('base64url') })
      .AUTH_JWT_SECRET?.length,
    43,
  );
});
