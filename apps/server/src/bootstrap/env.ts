import { z } from 'zod';
import { EMAIL_FROM_SCHEMA } from '../infrastructure/email/index.js';
import { type CloudAgentConfiguration, parseCloudAgentConfiguration } from './agent-config.js';

const DATABASE_ENV_SCHEMA = z.object({ DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }) });
const COMMON_ENV_SCHEMA = DATABASE_ENV_SCHEMA.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  REDIS_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('always-on'),
});
const API_ENV_SCHEMA = COMMON_ENV_SCHEMA.extend({
  APP_NAME: z.string().trim().min(1).max(100).default('Always On'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3001'),
  BETTER_AUTH_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: EMAIL_FROM_SCHEMA.default('Always On <onboarding@resend.dev>'),
}).superRefine(validateAuthenticationEnv);
const WORKER_ENV_SCHEMA = COMMON_ENV_SCHEMA.extend({
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
});

/** Deployment variables required by the HTTP process. */
export interface ApiEnv extends z.infer<typeof API_ENV_SCHEMA> {
  readonly cloudAgent: CloudAgentConfiguration | null;
}
/** Deployment variables required by the background process. */
export interface WorkerEnv extends z.infer<typeof WORKER_ENV_SCHEMA> {
  readonly cloudAgent: CloudAgentConfiguration | null;
}
/** Deployment variables required by a database migration. */
export type DatabaseEnv = z.infer<typeof DATABASE_ENV_SCHEMA>;

function validateAuthenticationEnv(
  env: {
    NODE_ENV: string;
    BETTER_AUTH_URL: string;
    GOOGLE_CLIENT_ID?: string | undefined;
    GOOGLE_CLIENT_SECRET?: string | undefined;
    GITHUB_CLIENT_ID?: string | undefined;
    GITHUB_CLIENT_SECRET?: string | undefined;
  },
  context: z.RefinementCtx,
) {
  // Incomplete pairs must fail at startup rather than leave a visible but unusable login method.
  const pairs = [
    ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  ] as const;

  for (const [clientId, clientSecret] of pairs) {
    if (Boolean(env[clientId]) === Boolean(env[clientSecret])) continue;

    context.addIssue({
      code: 'custom',
      path: [clientId],
      message: `Configure ${clientId} and ${clientSecret} together`,
    });
  }
  if (env.NODE_ENV === 'production' && new URL(env.BETTER_AUTH_URL).protocol !== 'https:')
    context.addIssue({
      code: 'custom',
      path: ['BETTER_AUTH_URL'],
      message: 'Production authentication requires HTTPS',
    });
}

/** Parses API configuration once at process startup, without reporting secret values. */
export function parseApiEnv(input: unknown): ApiEnv {
  const result = API_ENV_SCHEMA.safeParse(input);
  if (result.success) return { ...result.data, cloudAgent: parseCloudAgentConfiguration(input) };

  throwConfigurationError({ role: 'API', issues: result.error.issues });
}

/** Parses Worker configuration independently of HTTP-only settings. */
export function parseWorkerEnv(input: unknown): WorkerEnv {
  const result = WORKER_ENV_SCHEMA.safeParse(input);
  if (result.success) return { ...result.data, cloudAgent: parseCloudAgentConfiguration(input) };

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
