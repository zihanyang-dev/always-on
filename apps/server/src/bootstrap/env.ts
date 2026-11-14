import { z } from 'zod';

const DATABASE_ENV_SCHEMA = z.object({ DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }) });
const COMMON_ENV_SCHEMA = DATABASE_ENV_SCHEMA.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});
const API_ENV_SCHEMA = COMMON_ENV_SCHEMA.extend({
  APP_NAME: z.string().trim().min(1).max(100).default('Always On'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
});
const WORKER_ENV_SCHEMA = COMMON_ENV_SCHEMA.extend({
  REDIS_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('always-on'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
});

/** Deployment variables required by the HTTP process. */
export type ApiEnv = z.infer<typeof API_ENV_SCHEMA>;
/** Deployment variables required by the background process. */
export type WorkerEnv = z.infer<typeof WORKER_ENV_SCHEMA>;
/** Deployment variables required by a database migration. */
export type DatabaseEnv = z.infer<typeof DATABASE_ENV_SCHEMA>;

/** Parses API configuration once at process startup, without reporting secret values. */
export function parseApiEnv(input: unknown): ApiEnv {
  const result = API_ENV_SCHEMA.safeParse(input);
  if (result.success) return result.data;
  throwConfigurationError({ role: 'API', issues: result.error.issues });
}

/** Parses Worker configuration independently of HTTP-only settings. */
export function parseWorkerEnv(input: unknown): WorkerEnv {
  const result = WORKER_ENV_SCHEMA.safeParse(input);
  if (result.success) return result.data;
  throwConfigurationError({ role: 'Worker', issues: result.error.issues });
}

/** Parses only the database connection required by migration tools. */
export function parseDatabaseEnv(input: unknown): DatabaseEnv {
  const result = DATABASE_ENV_SCHEMA.safeParse(input);
  if (result.success) return result.data;
  throwConfigurationError({ role: 'database', issues: result.error.issues });
}

function throwConfigurationError({
  role,
  issues,
}: {
  role: string;
  issues: readonly z.core.$ZodIssue[];
}): never {
  // Schema messages explain the rule; raw environment values never enter the diagnostic.
  const failures = issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid ${role} configuration: ${failures.join('; ')}`);
}
