import { PrismaMariaDb } from '@prisma/adapter-mariadb';

export function createMysqlAdapter(databaseUrl: string): PrismaMariaDb {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'mysql:') throw new Error('DATABASE_URL must use mysql');
  if (url.search)
    throw new Error(
      'Configure MySQL adapter options explicitly; URL query options are not supported yet',
    );
  return new PrismaMariaDb({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    connectionLimit: 5,
    connectTimeout: 5000,
    timezone: 'Z',
    initSql: "SET time_zone = '+00:00'",
  });
}
