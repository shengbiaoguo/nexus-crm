import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'docs/project-tree.txt');
const ignored = new Set([
  'node_modules',
  '.tools',
  '.pnpm-store',
  '.git',
  'dist',
  'dist-test',
  'generated',
  'artifacts',
  '.docs-baseline.json',
]);
await writeFile(target, '');
const lines = ['nexus-crm/'];
async function walk(directory, prefix) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) =>
        !ignored.has(entry.name) &&
        (!entry.name.startsWith('.env') || entry.name.endsWith('.example')),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const [index, entry] of entries.entries()) {
    const last = index === entries.length - 1;
    lines.push(
      `${prefix}${last ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 '}${entry.name}${entry.isDirectory() ? '/' : ''}`,
    );
    if (entry.isDirectory())
      await walk(path.join(directory, entry.name), prefix + (last ? '    ' : '\u2502   '));
  }
}
await walk(root, '');
await writeFile(target, lines.join('\n') + '\n');
console.log(lines.join('\n'));
