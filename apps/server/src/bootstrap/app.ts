import { IncomingMessage } from 'node:http';
import type { ModelCatalog } from '@always-on/contracts/models';
import { PUBLIC_CONFIG_SCHEMA } from '@always-on/contracts/system';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { createAgentRoutes } from '../agents/index.js';
import type { Authentication } from '../infrastructure/authentication/index.js';
import type { Database } from '../infrastructure/database/index.js';
import { createSessionRoutes } from '../sessions/index.js';
import { checkReadiness, type ReadinessChecks } from '../system/index.js';
import { createUserRoutes } from '../users/index.js';

const AUTH_BODY_LIMIT_BYTES = 16 * 1_024;

/** Composes public health routes and authenticated features without opening connections. */
export function createApp({
  name,
  checks,
  authentication,
  onError,
  execution,
}: {
  name: string;
  checks: ReadinessChecks;
  authentication: Pick<Authentication, 'handle' | 'getUser' | 'methods'>;
  onError: (error: Error) => void;
  execution?: {
    readonly db: Database;
    readonly catalog: ModelCatalog;
    readonly events?: { readonly redisUrl: string; readonly prefix: string };
  };
}): Hono {
  const app = new Hono();
  // Build the public allowlist once; deployment environment objects never reach a response.
  const publicConfig = PUBLIC_CONFIG_SCHEMA.parse({
    name,
    authentication: { methods: [...authentication.methods] },
    capabilities: {
      agentExecution: Boolean(execution),
      localConnection: false,
      cloudSandbox: Boolean(execution),
    },
  });
  app.use('*', secureHeaders());
  app.use('/api/auth/*', bodyLimit({ maxSize: AUTH_BODY_LIMIT_BYTES }));
  app.use('/api/auth/*', async (ctx, next) => {
    await next();
    // The SDK returns its own Response, so apply privacy headers after it has been attached.
    ctx.header('Cache-Control', 'no-store');
  });
  app.all('/api/auth/*', (ctx) => {
    return authentication.handle({ request: ctx.req.raw, clientIp: getClientIp(ctx.env) });
  });
  app.route('/api', createUserRoutes({ getUser: authentication.getUser }));
  if (execution) {
    const dependencies = {
      db: execution.db,
      catalog: execution.catalog,
      getUser: authentication.getUser,
      ...(execution.events ? { events: { ...execution.events, onError } } : {}),
    };
    app.route('/api/agents', createAgentRoutes(dependencies));
    app.route('/api/sessions', createSessionRoutes(dependencies));
  }
  app.get('/api/health/live', (ctx) => ctx.json({ status: 'ok' }));
  app.get('/api/health/ready', async (ctx) => {
    const readiness = await checkReadiness(checks);
    return ctx.json(readiness, readiness.status === 'ready' ? 200 : 503);
  });
  app.get('/api/public-config', (ctx) => ctx.json(publicConfig));
  app.notFound((ctx) => ctx.json({ code: 'not_found', message: 'Endpoint not found' }, 404));
  app.onError((error, ctx) => {
    if (error instanceof HTTPException && error.status < 500) return error.getResponse();
    onError(error);
    return ctx.json({ code: 'internal_error', message: 'Request could not be completed' }, 500);
  });
  return app;
}

function getClientIp(bindings: unknown) {
  // In-process requests have no socket; forwarding headers never establish a caller's identity.
  if (!bindings || typeof bindings !== 'object' || !('incoming' in bindings)) return undefined;
  if (!(bindings.incoming instanceof IncomingMessage)) return undefined;
  return bindings.incoming.socket.remoteAddress;
}
