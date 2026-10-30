import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
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
  config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)), quiet: true });
  return validateEnvironment(process.env);
}
