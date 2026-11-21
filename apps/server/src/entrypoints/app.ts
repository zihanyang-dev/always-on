import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { type AccessOptions, createAccess } from '../access/index.ts';
import { createWebhookRoutes, type FindWebhookConnection } from '../channels/index.ts';
import {
  errorResponse,
  type HttpEnv,
  httpErrorHandler,
  observeHttpRequests,
} from '../http/index.ts';
import type { Observability } from '../infrastructure/index.ts';
import {
  createInbox,
  createInboxRoutes,
  createWorkRoutes,
  createWorkStore,
} from '../work/index.ts';

type AppOptions = AccessOptions & {
  observability?: Observability;
  findWebhookConnection?: FindWebhookConnection;
};

/** Builds the HTTP application independently of the server socket. */
export function createApp({
  observability,
  findWebhookConnection,
  ...accessOptions
}: AppOptions): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  if (observability) app.use('*', observeHttpRequests(observability));
  app.use('*', secureHeaders());

  app.get('/health', (ctx) => ctx.json({ status: 'ok' }));

  const access = createAccess(accessOptions);
  const inbox = createInbox(accessOptions.db, observability);
  const work = createWorkStore(accessOptions.db);
  const { origin } = accessOptions.config;

  app.route('/api', access.routes);

  app.route('/api', createInboxRoutes({ inbox, origin, getUser: access.getUser }));

  app.route(
    '/api/work',
    createWorkRoutes({ work, origin, getUser: access.getUser, findConnectionWorkspace }),
  );

  if (findWebhookConnection) {
    app.route(
      '/api/webhooks',
      createWebhookRoutes({
        findConnection: findWebhookConnection,
        acceptEvent: inbox.acceptChannelEvent,
      }),
    );
  }

  app.notFound((ctx) => errorResponse(ctx, 404, 'not_found'));

  app.onError(httpErrorHandler(accessOptions.reportError));

  return app;

  async function findConnectionWorkspace(connectionId: string) {
    const connection = await findWebhookConnection?.(connectionId);
    return connection?.workspaceId ?? null;
  }
}
