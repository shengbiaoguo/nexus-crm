import { createPrismaClient } from '../infrastructure/prisma-client.js';
import { localDatabaseUrl } from './local-database.js';
import { seedBaseline } from './seed-baseline.js';

let client;
try {
  client = createPrismaClient(localDatabaseUrl());
  const result = await seedBaseline(client);
  console.log(
    result.created
      ? 'PASS M0 dictionary initialized; no users or test fixtures created.'
      : 'PASS M0 dictionary already matches; no grants overwritten.',
  );
} catch {
  console.error(
    'M0 seed failed: check local configuration, migration state or changed baseline templates. No credentials printed.',
  );
  process.exitCode = 1;
} finally {
  await client?.$disconnect();
}
