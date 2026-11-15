import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { openDatabase } from '../infrastructure/database/index.js';
import { openAgentWorker } from '../tasks/index.js';
import { executeCloudRun } from './cloud-agent.js';
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
  const config = env.cloudAgent;
  // Without an execution provider there is no queue consumer to start.
  if (!config) return;

  const logger = pino({ level: env.LOG_LEVEL, base: { process: 'worker' } });
  const onError = (error: Error) => logger.error({ err: error }, 'Worker dependency failed');

  using shutdown = observeShutdown();
  await using database = openDatabase({ url: env.DATABASE_URL, onError });
  // Verify storage before starting a consumer that may immediately receive work.
  await database.check();

  const execution = { db: database.db, config, createId: randomUUID, onError };
  await using agentWorker = await openAgentWorker({
    db: database.db,
    redisUrl: env.REDIS_URL,
    prefix: env.REDIS_PREFIX,
    concurrency: env.WORKER_CONCURRENCY,
    createId: randomUUID,
    onError,
    execute: (claim, context) => executeCloudRun({ ...execution, claim, context }),
  });
  logger.info('Worker listening');

  const failure = await Promise.race([shutdown.wait, agentWorker.failure]);
  if (failure) throw failure;

  logger.info('Worker stopping');
}
