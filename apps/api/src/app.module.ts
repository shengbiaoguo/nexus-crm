import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { LoggingModule } from './logging/logging.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import type { Environment } from './config/environment.js';
import { DatabaseModule } from './infrastructure/database.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';

@Module({ imports: [LoggingModule, AuditModule], controllers: [HealthController] })
export class AppModule {
  static register(environment: Environment) {
    const database = DatabaseModule.register(environment.DATABASE_URL);
    const authentication = AuthModule.register(environment, database);
    return {
      module: AppModule,
      imports: [
        authentication,
        AuthorizationModule.register(database, authentication),
        IdempotencyModule.register(database, environment.DATABASE_URL),
      ],
    };
  }
}
