import { Module, type DynamicModule } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { createPrismaClient } from '../infrastructure/prisma-client.js';
import { IdempotencyService, RECOVERY_CLIENT } from './idempotency.service.js';
import { IdempotencyStore } from './idempotency.store.js';

@Module({})
export class IdempotencyModule {
  static register(database: DynamicModule, databaseUrl: string): DynamicModule {
    return {
      module: IdempotencyModule,
      imports: [database, AuditModule],
      providers: [
        IdempotencyService,
        IdempotencyStore,
        { provide: RECOVERY_CLIENT, useValue: () => createPrismaClient(databaseUrl) },
      ],
      exports: [IdempotencyService],
    };
  }
}
