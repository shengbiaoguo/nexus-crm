import { copyFile, constants } from 'node:fs/promises';

try {
  await copyFile(
    new URL('../.env.example', import.meta.url),
    new URL('../.env', import.meta.url),
    constants.COPYFILE_EXCL,
  );
  console.log(
    'Created .env with placeholders. Set your local service credentials before service checks.',
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .env preserved.');
}
