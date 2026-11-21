import { openDatabase } from '../infrastructure/database/index.ts';
import { startObservability } from '../infrastructure/index.ts';
import { consumeWorkInbox, createInbox, createWorkRouter } from '../work/index.ts';
import { readWorkerConfig } from './config.ts';

const config = readWorkerConfig(process.env);
await using observability = startObservability(config.observability);
await using db = openDatabase(config.databaseUrl, reportError);

const controller = new AbortController();
const inbox = createInbox(db, observability);
const routeEvent = createWorkRouter(db, observability);

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  observability.logger.info('worker.started');
  await consumeWorkInbox({ inbox, routeEvent, reportError, signal: controller.signal });
  observability.logger.info('worker.stopped');
} finally {
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
}

function stop() {
  controller.abort();
}

function reportError(error: unknown) {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  observability.logger.error({ error_type: errorType }, 'worker.error');
}
