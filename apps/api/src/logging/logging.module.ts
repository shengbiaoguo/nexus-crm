import { Module } from '@nestjs/common';
import { StructuredLogger } from './structured-logger.service.js';

@Module({
  providers: [{ provide: StructuredLogger, useFactory: () => new StructuredLogger() }],
  exports: [StructuredLogger],
})
export class LoggingModule {}
