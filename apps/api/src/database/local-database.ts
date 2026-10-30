import { loadEnvironment } from '../config/environment.js';

export function localDatabaseUrl(): string {
  const environment = loadEnvironment();
  const url = new URL(environment.DATABASE_URL);
  if (
    environment.NODE_ENV === 'production' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('M0 development tools require a local non-production database');
  }
  return environment.DATABASE_URL;
}
