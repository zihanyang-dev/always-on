import { pino } from 'pino';
import { hasWorkspaceAgents } from '../agents/index.js';
import {
  type AuthenticationConfig,
  createAuthentication,
  createAuthRateLimit,
  type OAuthCredentials,
} from '../infrastructure/authentication/index.js';
import { openDatabase } from '../infrastructure/database/index.js';
import { createResendSender } from '../infrastructure/email/index.js';
import { openRedis } from '../infrastructure/redis/index.js';
import { createWorkspacePlugin } from '../workspaces/index.js';
import { createApp } from './app.js';
import { loadAgentModelCatalog } from './cloud-agent.js';
import { parseApiEnv } from './env.js';
import { openHttpServer } from './http.js';
import { describeError, reportError } from './report-error.js';
import { observeShutdown } from './shutdown.js';

try {
  await main();
} catch (error) {
  reportError(error);
  process.exitCode = 1;
}

async function main() {
  const env = parseApiEnv(process.env);
  const logger = pino({ level: env.LOG_LEVEL, base: { process: 'api' } });
  const onError = (error: Error) =>
    logger.error({ failure: describeError(error) }, 'API dependency failed');

  using shutdown = observeShutdown();
  await using database = openDatabase({ url: env.DATABASE_URL, onError });
  await using redis = openRedis({ url: env.REDIS_URL, role: 'api', onError });
  await redis.client.connect();

  const sendEmail = env.RESEND_API_KEY
    ? createResendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM })
    : undefined;
  const authenticationConfig = {
    name: env.APP_NAME,
    baseUrl: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    google: getOAuthCredentials({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    }),
    github: getOAuthCredentials({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    }),
  } satisfies AuthenticationConfig;
  await using authentication = createAuthentication({
    db: database.db,
    config: authenticationConfig,
    sendEmail,
    rateLimit: createAuthRateLimit({ redis: redis.client, prefix: env.REDIS_PREFIX }),
    onError,
    createPlugins: (requireTransaction) => [
      createWorkspacePlugin({
        baseUrl: env.BETTER_AUTH_URL,
        sendEmail,
        canDeleteWorkspace: async (workspaceId) =>
          !(await hasWorkspaceAgents({ transaction: requireTransaction(), workspaceId })),
      }),
    ],
  });

  const execution = env.cloudAgent
    ? {
        db: database.db,
        catalog: await loadAgentModelCatalog(env.cloudAgent),
        events: { redisUrl: env.REDIS_URL, prefix: env.REDIS_PREFIX },
      }
    : undefined;
  const app = createApp({
    name: env.APP_NAME,
    checks: { database: database.check, redis: () => redis.client.ping() },
    authentication,
    onError,
    ...(execution ? { execution } : {}),
  });

  // Reverse-order disposal stops incoming requests before closing their backing connections.
  await using http = await openHttpServer({
    app,
    host: env.HOST,
    port: env.PORT,
  });
  logger.info({ port: http.port }, 'API listening');

  await shutdown.wait;
  logger.info('API stopping');
}

function getOAuthCredentials({
  clientId,
  clientSecret,
}: {
  clientId: string | undefined;
  clientSecret: string | undefined;
}): OAuthCredentials | undefined {
  // Disabled providers stay absent from the SDK's provider registry.
  if (!clientId || !clientSecret) return undefined;

  return { clientId, clientSecret };
}
