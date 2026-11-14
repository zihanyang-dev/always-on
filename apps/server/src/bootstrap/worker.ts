import { pino } from 'pino';
import { openDatabase } from '../infrastructure/database/index.js';
import { openSystemWorker } from '../system/index.js';
import { parseWorkerEnv } from './env.js';
import { reportError } from './report-error.js';
import { observeShutdown } from './shutdown.js';

try {
  await main();
} catch (error) {
  reportError(error);
  process.exitCode = 1;
}

async function main() {
  const env = parseWorkerEnv(process.env);
  const logger = pino({ level: env.LOG_LEVEL, base: { process: 'worker' } });
  const onError = (error: Error) => logger.error({ err: error }, 'Worker dependency failed');
  using shutdown = observeShutdown();
  await using database = openDatabase({ url: env.DATABASE_URL, onError });
  // Verify storage before starting a consumer that may immediately receive work.
  await database.check();
  await using worker = openSystemWorker({
    redisUrl: env.REDIS_URL,
    prefix: env.REDIS_PREFIX,
    concurrency: env.WORKER_CONCURRENCY,
    checkDatabase: database.check,
    now: () => new Date().toISOString(),
    onError,
  });
  await worker.ready();
  logger.info('Worker listening');
  await shutdown.wait;
  logger.info('Worker stopping');
}
