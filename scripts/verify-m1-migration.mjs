// Explicit local T04 rehearsal. Never creates/resets databases on ordinary test runs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '../apps/api/dist/config/environment.js';
import { createPrismaClient } from '../apps/api/dist/infrastructure/prisma-client.js';

const environment = loadEnvironment();
const base = new URL(environment.DATABASE_URL);
assert.notEqual(environment.NODE_ENV, 'production');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
assert.equal(base.pathname, '/nexus_crm');
const names = ['nexus_crm_shadow', 'nexus_crm_m1_empty', 'nexus_crm_m1_history'];
const artifact = new URL('../artifacts/t04-migration-baseline.json', import.meta.url);
const tables = [
  'users',
  'departments',
  'roles',
  'permissions',
  'user_roles',
  'role_permissions',
  'refresh_sessions',
  'audit_logs',
  'idempotency_records',
  'command_attempts',
];
const urlFor = (name) => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.href;
};
async function connected(url, work) {
  const client = createPrismaClient(url);
  try {
    return await work(client);
  } finally {
    await client.$disconnect();
  }
}
async function snapshot(client) {
  const result = {};
  for (const table of tables) {
    // Fixed allowlist; raw records and credentials are never printed or saved.
    const rows = await client.$queryRawUnsafe(`SELECT * FROM \`${table}\``);
    const encoded = rows
      .map((row) =>
        JSON.stringify(row, (_, value) => (typeof value === 'bigint' ? value.toString() : value)),
      )
      .sort();
    result[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(encoded.join('\n')).digest('hex'),
    };
  }
  result.migrations = await client.$queryRawUnsafe(
    'SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name',
  );
  return result;
}
function deploy(name, configPath) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../apps/api/node_modules/prisma/build/index.js', import.meta.url)),
      'migrate',
      'deploy',
      ...(configPath ? ['--config', configPath] : []),
    ],
    {
      cwd: fileURLToPath(new URL('../apps/api/', import.meta.url)),
      env: { ...process.env, DATABASE_URL: urlFor(name) },
      encoding: 'utf8',
    },
  );
  assert.equal(
    result.status,
    0,
    `Migration deploy failed for ${name}; inspect locally, credentials omitted`,
  );
  console.log(`PASS migrate deploy: ${name}`);
}
if (process.argv.includes('--prepare-authorized-local-databases')) {
  // Replay the actual historical SQL in isolation, even on a checkout containing M1.
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  const rehearsal = await mkdtemp(
    fileURLToPath(new URL('../artifacts/t04-history-', import.meta.url)),
  );
  const migrations = `${rehearsal}/migrations`;
  await mkdir(migrations);
  for (const name of [
    '20261030014538_init_m0',
    '20261030020831_align_m0_collation',
    'migration_lock.toml',
  ]) {
    await cp(
      new URL(`../apps/api/prisma/migrations/${name}`, import.meta.url),
      `${migrations}/${name}`,
      { recursive: true },
    );
  }
  const configPath = `${rehearsal}/prisma.config.ts`;
  await writeFile(
    configPath,
    `import { defineConfig } from ${JSON.stringify(new URL('../apps/api/node_modules/prisma/config.js', import.meta.url).href)};\nexport default defineConfig({ schema: ${JSON.stringify(fileURLToPath(new URL('../apps/api/prisma/schema.prisma', import.meta.url)))}, migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.DATABASE_URL } });\n`,
  );
  await connected(base.href, async (client) => {
    for (const name of names) {
      const existing =
        await client.$queryRaw`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=${name}`;
      assert.equal(existing.length, 0, `${name} already exists; refusing to overwrite or reset`);
    }
    for (const name of names) {
      await client.$executeRawUnsafe(
        `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
    }
  });
  deploy('nexus_crm_m1_history', configPath);
  const history = await connected(urlFor('nexus_crm_m1_history'), async (client) => {
    const user = await client.user.create({
      data: {
        loginName: `t04-history-${randomUUID()}`,
        name: 'T04 historical fixture',
        passwordHash: 'unused',
        status: 'DISABLED',
      },
    });
    await client.auditLog.create({
      data: {
        actorId: user.id,
        action: 't04.history',
        entityType: 'user',
        entityId: user.id.toString(),
        requestId: randomUUID(),
      },
    });
    return snapshot(client);
  });
  assert.equal(history.migrations.length, 2, 'Prepare before generating M1 migration');
  const dev = await connected(base.href, snapshot);
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(artifact, JSON.stringify({ dev, history }, null, 2) + '\n');
  console.log(
    'PASS authorized local test databases prepared; M0 fingerprints saved without raw records',
  );
} else if (process.argv.includes('--verify-authorized-local-upgrade')) {
  const baseline = JSON.parse(await readFile(artifact, 'utf8'));
  // Empty target must still be empty; this tool never resets a used target.
  await connected(urlFor('nexus_crm_m1_empty'), async (client) => {
    const rows =
      await client.$queryRaw`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()`;
    assert.equal(rows.length, 0);
  });
  deploy('nexus_crm_m1_empty');
  deploy('nexus_crm_m1_history');
  for (const [name, before] of [
    ['nexus_crm', baseline.dev],
    ['nexus_crm_m1_history', baseline.history],
  ]) {
    const current = await connected(urlFor(name), snapshot);
    const m0 = { ...current, migrations: current.migrations.slice(0, 2) };
    assert.deepEqual(m0, before, `${name}: historical rows/checksums changed`);
    assert.equal(current.migrations.length, 3);
    console.log(`PASS ${name}: all M0 rows and historical migration checksums unchanged`);
  }
  console.log('PASS empty and historical M0 upgrades; databases retained');
} else {
  throw new Error('Explicit authorized preparation or upgrade verification flag required');
}
