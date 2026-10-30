import { Module, type DynamicModule } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

@Module({})
export class DatabaseModule {
  static register(databaseUrl: string): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [{ provide: PrismaService, useFactory: () => new PrismaService(databaseUrl) }],
      exports: [PrismaService],
    };
  }
}
