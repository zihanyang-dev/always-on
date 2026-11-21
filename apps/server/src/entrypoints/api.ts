import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { openDatabase } from '../infrastructure/database/index.ts';
import { createEmailSender, startObservability } from '../infrastructure/index.ts';
import { createApp } from './app.ts';
import { readApiConfig } from './config.ts';

const config = readApiConfig(process.env);
await using observability = startObservability(config.observability);
await using db = openDatabase(config.databaseUrl, reportError);
const app = createApp({
  db,
  config: config.auth,
  sendEmail: config.email && createEmailSender(config.email),
  reportError,
  observability,
});

const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  ({ address, port }) => observability.logger.info({ address, port }, 'api.listening'),
);

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  await once(server, 'close');
  observability.logger.info('api.stopped');
} finally {
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
}

function stop() {
  server.close();
}

function reportError(error: unknown) {
  // Driver and provider errors may contain query parameters or signed URLs.
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  observability.logger.error({ error_type: errorType }, 'api.error');
}
