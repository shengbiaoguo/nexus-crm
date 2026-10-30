import { Module } from '@nestjs/common';
import { LoggingModule } from '../logging/logging.module.js';
import { AuditService } from './audit.service.js';

@Module({ imports: [LoggingModule], providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
