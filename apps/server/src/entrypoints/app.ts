import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { type AccessOptions, createAccessRoutes } from '../access/index.ts';
import {
  errorResponse,
  type HttpEnv,
  httpErrorHandler,
  observeHttpRequests,
} from '../http/index.ts';
import type { Observability } from '../infrastructure/index.ts';

/** Builds the HTTP application independently of the server socket. */
export function createApp(
  options: AccessOptions & { observability?: Observability },
): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  if (options.observability) app.use('*', observeHttpRequests(options.observability));
  app.use('*', secureHeaders());

  app.get('/health', (ctx) => ctx.json({ status: 'ok' }));

  app.route('/api', createAccessRoutes(options));

  app.notFound((ctx) => errorResponse(ctx, 404, 'not_found'));
  app.onError(httpErrorHandler(options.reportError));

  return app;
}
