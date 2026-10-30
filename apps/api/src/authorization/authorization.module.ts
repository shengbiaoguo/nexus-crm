import { Module, type DynamicModule } from '@nestjs/common';
import { AuthorizationService } from './authorization.service.js';
import { IdentityReadService } from './identity-read.service.js';
import { IdentityReadController } from './identity-read.controller.js';

@Module({})
export class AuthorizationModule {
  static register(database: DynamicModule, authentication: DynamicModule): DynamicModule {
    return {
      module: AuthorizationModule,
      imports: [database, authentication],
      controllers: [IdentityReadController],
      providers: [AuthorizationService, IdentityReadService],
      exports: [AuthorizationService],
    };
  }
}
