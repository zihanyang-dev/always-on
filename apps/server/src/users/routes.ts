import type { UserProfile } from '@always-on/contracts/users';
import { Hono } from 'hono';

/** Exposes only the authenticated user's profile through the identity capability. */
export function createUserRoutes({
  getUser,
}: {
  getUser: (headers: Headers) => Promise<UserProfile | null>;
}): Hono {
  const routes = new Hono();
  routes.get('/me', async (ctx) => {
    // Shared caches must not reuse one person's profile after the browser switches accounts.
    ctx.header('Cache-Control', 'no-store');
    const user = await getUser(ctx.req.raw.headers);
    if (!user) return ctx.json({ code: 'unauthenticated', message: 'Sign in to continue' }, 401);
    return ctx.json(user);
  });
  return routes;
}
