import { createPrismaClient } from '../infrastructure/prisma-client.js';
import { localDatabaseUrl } from '../database/local-database.js';
import { AttemptReconciliationService } from './attempt-reconciliation.service.js';
import { IdempotencyStore } from '../idempotency/idempotency.store.js';

let client;
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !/^--after-id=(0|[1-9][0-9]{0,19})$/.test(args[0])))
    throw new Error('Invalid cursor');
  const afterId = args[0] ? BigInt(args[0].slice('--after-id='.length)) : 0n;
  if (afterId > 18446744073709551615n) throw new Error('Invalid cursor');
  client = createPrismaClient(localDatabaseUrl());
  console.log(
    JSON.stringify(
      await new AttemptReconciliationService(new IdempotencyStore()).runBatch(client, afterId),
    ),
  );
} catch {
  console.error(
    'Attempt reconciliation failed; keep the cursor and verify local database availability. No business was replayed.',
  );
  process.exitCode = 1;
} finally {
  await client?.$disconnect();
}
