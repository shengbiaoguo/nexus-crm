import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { SignJWT, jwtVerify, errors } from 'jose';
import { ApiException } from '../http/api.exception.js';

const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, key) => (error ? reject(error) : resolve(key)));
  });

/** Controlled account provisioning must use this format; no plaintext fallback. */
export async function hashPassword(password: string): Promise<string> {
  if (!password.length || Buffer.byteLength(password) > 1024)
    throw new TypeError('Invalid password length');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$32768$8$1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const valid = /^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(hash);
  const parts = hash.split('$');
  // Unknown accounts and unsupported hashes still perform the same expensive KDF.
  const actual = await derive(password, valid ? parts[4]! : '0'.repeat(32));
  return timingSafeEqual(actual, Buffer.from(valid ? parts[5]! : '0'.repeat(128), 'hex')) && valid;
}

export const refreshHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const newRefreshToken = () => randomBytes(32).toString('base64url');
export const unauthenticated = () =>
  new ApiException('UNAUTHENTICATED', 'Invalid credentials or session');

export interface AccessIdentity {
  sub: string;
  sid: string;
  cv: number;
}
const id = /^[1-9][0-9]{0,19}$/;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && id.test(value) && BigInt(value) <= 18446744073709551615n;

export class AccessTokens {
  constructor(
    private readonly secret: string,
    private readonly now = () => new Date(),
  ) {}
  async sign(identity: AccessIdentity): Promise<string> {
    return new SignJWT({ sid: identity.sid, cv: identity.cv })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setSubject(identity.sub)
      .setIssuer('nexus-crm')
      .setAudience('nexus-crm-api')
      .setIssuedAt(Math.floor(this.now().getTime() / 1000))
      .setExpirationTime(Math.floor(this.now().getTime() / 1000) + 900)
      .sign(Buffer.from(this.secret, 'base64url'));
  }
  async verify(token: string): Promise<AccessIdentity> {
    try {
      if (token.length > 2048) throw unauthenticated();
      const { payload } = await jwtVerify(token, Buffer.from(this.secret, 'base64url'), {
        algorithms: ['HS256'],
        typ: 'at+jwt',
        issuer: 'nexus-crm',
        audience: 'nexus-crm-api',
        requiredClaims: ['sub', 'sid', 'cv', 'iat', 'exp'],
        currentDate: this.now(),
        maxTokenAge: '15m',
      });
      if (
        !validId(payload.sub) ||
        !validId(payload.sid) ||
        !Number.isSafeInteger(payload.cv) ||
        (payload.cv as number) < 1
      )
        throw unauthenticated();
      return { sub: payload.sub, sid: payload.sid, cv: payload.cv as number };
    } catch (error) {
      if (error instanceof errors.JWTExpired)
        throw new ApiException('TOKEN_EXPIRED', 'Access token expired');
      throw unauthenticated();
    }
  }
}
