import { createApplication } from './application.js';
import { loadEnvironment } from './config/environment.js';
import { StructuredLogger } from './logging/structured-logger.service.js';

try {
  const environment = loadEnvironment();
  const { app } = await createApplication(environment);
  await app.listen(environment.API_PORT, environment.API_HOST);
} catch {
  new StructuredLogger().event('error', 'startup_failed');
  process.exitCode = 1;
}
