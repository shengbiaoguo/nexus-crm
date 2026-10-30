import { Module, type DynamicModule } from '@nestjs/common';
import type { Environment } from '../config/environment.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthController } from './auth.controller.js';
import { AUTH_ENVIRONMENT } from './auth.config.js';
import { AuthGuard, AuthThrottleGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';

@Module({})
export class AuthModule {
  static register(environment: Environment, database: DynamicModule): DynamicModule {
    return {
      module: AuthModule,
      imports: [AuditModule, database],
      controllers: [AuthController],
      providers: [
        { provide: AUTH_ENVIRONMENT, useValue: environment },
        AuthService,
        AuthGuard,
        AuthThrottleGuard,
      ],
      exports: [AuthService, AuthGuard],
    };
  }
}
