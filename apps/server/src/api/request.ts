import type { UserProfile } from '@always-on/contracts/users';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import type { z } from 'zod';

/** Identity access required by HTTP features, without authentication SDK internals. */
export type GetRequestUser = (headers: Headers) => Promise<UserProfile | null>;

/** Request state established by authentication before feature handlers run. */
export type AuthenticatedApiEnv = { Variables: { userId: string } };

/** Feature routes whose request context already contains an authenticated identity. */
export type AuthenticatedRouter = Hono<AuthenticatedApiEnv>;

/** Builds a feature router whose handlers receive an authenticated user identity. */
export function createAuthenticatedRouter(getUser: GetRequestUser): AuthenticatedRouter {
  const routes = new Hono<AuthenticatedApiEnv>();
  routes.use('*', bodyLimit({ maxSize: 256 * 1_024 }));
  routes.use('*', csrf());
  routes.use('*', async (ctx, next) => {
    ctx.header('Cache-Control', 'no-store');
    const user = await getUser(ctx.req.raw.headers);
    if (!user) return ctx.json({ code: 'unauthenticated', message: 'Sign in to continue' }, 401);
    ctx.set('userId', user.id);
    await next();
  });
  return routes;
}

/** Redacts submitted values from schema failures at every protected HTTP boundary. */
export function handleValidationResult(
  result: { success: true } | { success: false; error: z.core.$ZodError },
  ctx: Pick<Context, 'json'>,
): Response | undefined {
  if (result.success) return;
  return ctx.json(
    { code: 'invalid_input', fields: result.error.issues.map((issue) => issue.path.join('.')) },
    400,
  );
}
