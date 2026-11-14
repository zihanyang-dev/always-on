import { pino } from 'pino';
import { openDatabase } from '../infrastructure/database/index.js';
import { openRedis } from '../infrastructure/redis/index.js';
import { createApp } from './app.js';
import { parseApiEnv } from './env.js';
import { openHttpServer } from './http.js';
import { reportError } from './report-error.js';
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
  const onError = (error: Error) => logger.error({ err: error }, 'API dependency failed');
  using shutdown = observeShutdown();
  await using database = openDatabase({ url: env.DATABASE_URL, onError });
  await using redis = openRedis({ url: env.REDIS_URL, role: 'api', onError });
  await redis.client.connect();
  const app = createApp({
    name: env.APP_NAME,
    checks: { database: database.check, redis: () => redis.client.ping() },
    onError,
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
