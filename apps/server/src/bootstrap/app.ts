import { PUBLIC_CONFIG_SCHEMA } from '@always-on/contracts/system';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { checkReadiness, type ReadinessChecks } from '../system/index.js';

/** Builds read-only bootstrap routes without opening connections or exposing env. */
export function createApp({
  name,
  checks,
  onError,
}: {
  name: string;
  checks: ReadinessChecks;
  onError: (error: Error) => void;
}): Hono {
  const app = new Hono();
  // Build the public allowlist once; deployment environment objects never reach a response.
  const publicConfig = PUBLIC_CONFIG_SCHEMA.parse({
    name,
    capabilities: { agentExecution: false, localConnection: false, cloudSandbox: false },
  });
  app.use('*', secureHeaders());
  app.get('/api/health/live', (ctx) => ctx.json({ status: 'ok' }));
  app.get('/api/health/ready', async (ctx) => {
    const readiness = await checkReadiness(checks);
    return ctx.json(readiness, readiness.status === 'ready' ? 200 : 503);
  });
  app.get('/api/public-config', (ctx) => ctx.json(publicConfig));
  app.notFound((ctx) => ctx.json({ code: 'not_found', message: 'Endpoint not found' }, 404));
  app.onError((error, ctx) => {
    onError(error);
    return ctx.json({ code: 'internal_error', message: 'Request could not be completed' }, 500);
  });
  return app;
}
