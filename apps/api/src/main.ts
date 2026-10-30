import { createApplication } from './application.js';
import { loadEnvironment } from './config/environment.js';

try {
  const environment = loadEnvironment();
  const { app } = await createApplication(environment);
  await app.listen(environment.API_PORT, environment.API_HOST);
} catch {
  console.error(
    JSON.stringify({
      event: 'startup_failed',
      message: 'Check environment configuration and port availability',
    }),
  );
  process.exitCode = 1;
}
