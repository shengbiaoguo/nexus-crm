import { PrismaClient } from '../generated/prisma/client.js';
import { createMysqlAdapter } from './mysql-adapter.js';

// Factory only: HTTP liveness must not open database connections.
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: createMysqlAdapter(databaseUrl) });
}
