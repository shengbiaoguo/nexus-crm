import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  AUTH_JWT_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .refine(
      (value) =>
        Buffer.from(value, 'base64url').length === 32 &&
        Buffer.from(value, 'base64url').toString('base64url') === value,
    )
    .optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGIN: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  DATABASE_URL: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'mysql:' && url.hostname.length > 0 && url.pathname.length > 1;
  }),
  REDIS_URL: z.url().refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol)),
});

export type Environment = z.infer<typeof schema>;

export function validateEnvironment(values: NodeJS.ProcessEnv): Environment {
  const result = schema.safeParse(values);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment variables: ${fields.join(', ')}`);
  }
  return result.data;
}

export function loadEnvironment(): Environment {
  // Compiled integration tests add another directory level; locate the workspace marker.
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'pnpm-workspace.yaml'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Workspace configuration root not found');
    directory = parent;
  }
  config({ path: join(directory, '.env'), quiet: true });
  return validateEnvironment(process.env);
}
