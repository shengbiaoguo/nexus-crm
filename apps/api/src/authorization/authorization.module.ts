import { Module, type DynamicModule } from '@nestjs/common';
import { AuthorizationService } from './authorization.service.js';
import { IdentityReadService } from './identity-read.service.js';
import { IdentityReadController } from './identity-read.controller.js';
import { SalesAuthorizationService } from './sales-authorization.service.js';
import { WriteLockService } from './write-lock.service.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({})
export class AuthorizationModule {
  static register(database: DynamicModule, authentication: DynamicModule): DynamicModule {
    return {
      module: AuthorizationModule,
      imports: [database, authentication, AuditModule],
      controllers: [IdentityReadController],
      providers: [
        AuthorizationService,
        IdentityReadService,
        SalesAuthorizationService,
        WriteLockService,
      ],
      exports: [AuthorizationService, SalesAuthorizationService, WriteLockService],
    };
  }
}
