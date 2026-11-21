import { z } from 'zod';
import type { AuthenticationConfig, OAuthCredentials } from '../access/index.ts';
import type { EmailConfig, ObservabilityConfig } from '../infrastructure/index.ts';

const OPTIONAL_SECRET = z.string().trim().min(1).optional();

const PROCESS_ENV = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  OTEL_SERVICE_NAME: z.string().trim().min(1).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url({ protocol: /^https?$/ })
    .refine(isOtlpEndpoint)
    .optional(),
});

const API_ENV = PROCESS_ENV.extend({
  NODE_ENV: z.string().optional(),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3001'),
  BETTER_AUTH_SECRET: z.string().min(32),
  GITHUB_CLIENT_ID: OPTIONAL_SECRET,
  GITHUB_CLIENT_SECRET: OPTIONAL_SECRET,
  GOOGLE_CLIENT_ID: OPTIONAL_SECRET,
  GOOGLE_CLIENT_SECRET: OPTIONAL_SECRET,
  RESEND_API_KEY: OPTIONAL_SECRET,
  EMAIL_FROM: z
    .string()
    .trim()
    .min(1)
    .regex(/^[^\r\n]+$/)
    .optional(),
});

type ProcessConfig = {
  databaseUrl: string;
  observability: ObservabilityConfig;
};

type ApiConfig = ProcessConfig & {
  host: string;
  port: number;
  auth: AuthenticationConfig;
  email: EmailConfig | undefined;
};

/** Parses deployment input once, without putting secret values in configuration errors. */
export function readApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const values = readEnv(API_ENV, env, 'API');
  const origin = readAuthOrigin({ url: values.BETTER_AUTH_URL, nodeEnv: values.NODE_ENV });
  const email = readEmailConfig({ apiKey: values.RESEND_API_KEY, from: values.EMAIL_FROM });

  return {
    ...readProcessConfig(values, 'always-on-api'),
    host: values.HOST,
    port: values.PORT,
    auth: {
      origin,
      secret: values.BETTER_AUTH_SECRET,
      github: readCredentials({
        provider: 'GITHUB',
        clientId: values.GITHUB_CLIENT_ID,
        clientSecret: values.GITHUB_CLIENT_SECRET,
      }),
      google: readCredentials({
        provider: 'GOOGLE',
        clientId: values.GOOGLE_CLIENT_ID,
        clientSecret: values.GOOGLE_CLIENT_SECRET,
      }),
    },
    email,
  };
}

export function readWorkerConfig(env: NodeJS.ProcessEnv): ProcessConfig {
  const values = readEnv(PROCESS_ENV, env, 'Worker');

  return readProcessConfig(values, 'always-on-worker');
}

function readEnv<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv, processName: string) {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;

  const fields = parsed.error.issues.map(({ path }) => path.join('.'));
  throw new Error(`Invalid ${processName} configuration: ${fields.join(', ')}`);
}

function readProcessConfig(
  values: z.output<typeof PROCESS_ENV>,
  serviceName: string,
): ProcessConfig {
  return {
    databaseUrl: values.DATABASE_URL,
    observability: {
      logLevel: values.LOG_LEVEL,
      serviceName: values.OTEL_SERVICE_NAME ?? serviceName,
      otlpEndpoint: values.OTEL_EXPORTER_OTLP_ENDPOINT,
    },
  };
}

function readAuthOrigin({ url, nodeEnv }: { url: string; nodeEnv: string | undefined }) {
  const parsed = new URL(url);
  const hasExtraParts =
    parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password;
  if (hasExtraParts) throw new Error('BETTER_AUTH_URL must be an origin');
  if (nodeEnv === 'production' && parsed.protocol !== 'https:')
    throw new Error('BETTER_AUTH_URL must use HTTPS in production');

  return parsed.origin;
}

function readEmailConfig({
  apiKey,
  from,
}: {
  apiKey: string | undefined;
  from: string | undefined;
}): EmailConfig | undefined {
  if (!apiKey) return undefined;
  if (!from) throw new Error('EMAIL_FROM is required when RESEND_API_KEY is set');

  return { apiKey, from };
}

function isOtlpEndpoint(value: string) {
  const parsed = URL.parse(value);
  return parsed !== null && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
}

function readCredentials({
  provider,
  clientId,
  clientSecret,
}: {
  provider: 'GITHUB' | 'GOOGLE';
  clientId: string | undefined;
  clientSecret: string | undefined;
}): OAuthCredentials | undefined {
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret)
    throw new Error(`Configure both ${provider}_CLIENT_ID and ${provider}_CLIENT_SECRET`);

  return { clientId, clientSecret };
}
