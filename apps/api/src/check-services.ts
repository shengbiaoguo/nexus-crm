import { Redis } from 'ioredis';
import { createPrismaClient } from './infrastructure/prisma-client.js';
import { loadEnvironment } from './config/environment.js';

// Explicit verification only; never imported by HTTP bootstrap. No schema/data mutations.
async function checkServices(): Promise<void> {
  const environment = loadEnvironment();
  if (new URL(environment.DATABASE_URL).password === 'replace_me') {
    throw new Error('Set local database credentials');
  }
  const mysqlHost = new URL(environment.DATABASE_URL).hostname;
  const redisHost = new URL(environment.REDIS_URL).hostname;
  if (![mysqlHost, redisHost].every((host) => ['localhost', '127.0.0.1', '[::1]'].includes(host))) {
    throw new Error('Use loopback local services');
  }
  const prisma = createPrismaClient(environment.DATABASE_URL);
  const redis = new Redis(environment.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 5000,
    retryStrategy: () => null,
  });
  redis.on('error', () => {
    /* Error details may contain connection settings; report only a safe summary below. */
  });
  try {
    const version = await prisma.$queryRaw<Array<{ version: string }>>`SELECT VERSION() AS version`;
    const actual = String(version[0]?.version);
    if (!actual.startsWith('8.4.')) throw new Error('Expected local MySQL 8.4');
    await redis.connect();
    if ((await redis.ping()) !== 'PONG') throw new Error('Redis PING failed');
    console.log(`PASS local MySQL ${actual} SELECT VERSION() and Redis PING; no tables created.`);
  } catch {
    console.error(
      'FAIL local service verification; check service availability, version and credentials.',
    );
    process.exitCode = 1;
  } finally {
    redis.disconnect();
    await prisma.$disconnect();
  }
}

try {
  await checkServices();
} catch {
  console.error(
    'FAIL local service configuration or connection; verify local URLs and credentials.',
  );
  process.exitCode = 1;
}
