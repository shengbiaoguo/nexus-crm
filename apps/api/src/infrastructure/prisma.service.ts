import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient } from './prisma-client.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/** One lazy client/connection pool per application DatabaseModule registration. */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  private instance?: PrismaClient;
  constructor(private readonly databaseUrl: string) {}
  get client(): PrismaClient {
    return (this.instance ??= createPrismaClient(this.databaseUrl));
  }
  async onModuleDestroy() {
    await this.instance?.$disconnect();
  }
}
