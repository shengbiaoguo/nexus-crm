import { Module, type DynamicModule } from '@nestjs/common';
import { AuthorizationService } from './authorization.service.js';
import { IdentityReadService } from './identity-read.service.js';
import { IdentityReadController } from './identity-read.controller.js';
import { SalesAuthorizationService } from './sales-authorization.service.js';
import { WriteLockService } from './write-lock.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { IdentityWriteController } from './identity-write.controller.js';
import { IdentityWriteService } from './identity-write.service.js';
import { SalesAccessService } from './sales-access.service.js';
import { SalesWriteService } from './sales-write.service.js';

@Module({})
export class AuthorizationModule {
  static register(
    database: DynamicModule,
    authentication: DynamicModule,
    commands: DynamicModule,
  ): DynamicModule {
    return {
      module: AuthorizationModule,
      imports: [database, authentication, AuditModule, commands],
      controllers: [IdentityReadController, IdentityWriteController],
      providers: [
        AuthorizationService,
        IdentityReadService,
        SalesAuthorizationService,
        WriteLockService,
        IdentityWriteService,
        SalesAccessService,
        SalesWriteService,
      ],
      exports: [
        AuthorizationService,
        SalesAuthorizationService,
        WriteLockService,
        SalesAccessService,
        SalesWriteService,
      ],
    };
  }
}
