import { loadEnvironment } from '../apps/api/dist/config/environment.js';
import { createPrismaClient } from '../apps/api/dist/infrastructure/prisma-client.js';

let client;
try {
  const environment = loadEnvironment();
  const url = new URL(environment.DATABASE_URL);
  if (
    environment.NODE_ENV === 'production' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('Only local non-production inspection is allowed');
  }
  client = createPrismaClient(environment.DATABASE_URL);
  const tables =
    await client.$queryRaw`SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`;
  console.log(
    JSON.stringify({
      local: true,
      environment: environment.NODE_ENV,
      tableCount: tables.length,
      tables: tables.map((row) => row.table_name),
    }),
  );
  if (process.argv.includes('--require-empty')) {
    const objects = tables.filter((row) => row.table_name !== '_prisma_migrations');
    const metadata = tables.some((row) => row.table_name === '_prisma_migrations')
      ? await client.$queryRaw`SELECT COUNT(*) AS count FROM _prisma_migrations`
      : [{ count: 0n }];
    if (objects.length !== 0 || BigInt(metadata[0].count) !== 0n) {
      console.error('STOP: database is not empty; no schema/data changes performed.');
      process.exitCode = 1;
    }
  }
} catch {
  console.error('Database inspection failed; no changes performed. Credentials omitted.');
  process.exitCode = 1;
} finally {
  await client?.$disconnect();
}
