import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { openDatabase } from '../infrastructure/database/index.js';
import { openSystemWorker } from '../system/index.js';
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

  const execution = env.cloudAgent
    ? { db: database.db, config: env.cloudAgent, createId: randomUUID, onError }
    : undefined;
  await using agentWorker = execution
    ? await openAgentWorker({
        db: database.db,
        redisUrl: env.REDIS_URL,
        prefix: env.REDIS_PREFIX,
        concurrency: env.WORKER_CONCURRENCY,
        createId: randomUUID,
        onError,
        execute: (claim, context) => executeCloudRun({ ...execution, claim, context }),
      })
    : undefined;
  logger.info('Worker listening');

  const failure = agentWorker
    ? await Promise.race([shutdown.wait, agentWorker.failure])
    : await shutdown.wait;
  if (failure) throw failure;

  logger.info('Worker stopping');
}
