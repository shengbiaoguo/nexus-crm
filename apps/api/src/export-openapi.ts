import { mkdir, writeFile } from 'node:fs/promises';
import { createApplication } from './application.js';
import { loadEnvironment } from './config/environment.js';

const { app, document } = await createApplication(loadEnvironment(), false);
try {
  const directory = new URL('../../../artifacts/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('openapi.json', directory), JSON.stringify(document, null, 2) + '\n');
} finally {
  await app.close();
}
