import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// Keep TypeScript decorator metadata identical in development and production.
const directory = new URL('../apps/api/', import.meta.url);
const compiler = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
    '-p',
    'tsconfig.json',
    '--watch',
    '--preserveWatchOutput',
  ],
  { cwd: directory, stdio: 'inherit' },
);
const server = spawn(process.execPath, ['--watch', 'dist/main.js'], {
  cwd: directory,
  stdio: 'inherit',
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all(
    [compiler, server].map(async (child) => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }),
  );
  process.exitCode = code;
}
for (const child of [compiler, server]) {
  child.on('error', () => void stop(1));
  child.on('exit', (code) => {
    if (!stopping) void stop(code ?? 1);
  });
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
