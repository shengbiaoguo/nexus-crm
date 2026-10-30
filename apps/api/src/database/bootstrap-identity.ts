import { createPrismaClient } from '../infrastructure/prisma-client.js';
import { localDatabaseUrl } from './local-database.js';
import { BootstrapIdentityService } from './bootstrap-identity.service.js';
import { AuditService } from '../audit/audit.service.js';
import { StructuredLogger } from '../logging/structured-logger.service.js';

let client;
try {
  if (process.argv.slice(2).join(' ') !== '--initialize-business-owner' || process.stdin.isTTY)
    throw new Error('Explicit bootstrap flag and protected JSON stdin required');
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 4096) throw new Error('Input limit');
  }
  client = createPrismaClient(localDatabaseUrl());
  const result = await new BootstrapIdentityService(
    new AuditService(new StructuredLogger()),
  ).initialize(client, JSON.parse(input) as unknown);
  console.log(JSON.stringify({ initialized: true, id: result.id }));
} catch {
  console.error(
    'Identity bootstrap failed. Verify input, baseline and outcome locally; credentials are not printed.',
  );
  process.exitCode = 1;
} finally {
  await client?.$disconnect();
}
