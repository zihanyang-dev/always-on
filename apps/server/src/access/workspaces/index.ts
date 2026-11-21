import { Hono } from 'hono';
import { errorResponse, limitApiBody } from '../../http/index.ts';
import type { SendEmail } from '../../infrastructure/index.ts';
import type { SignedInUser } from '../authentication/index.ts';
import { createInvitationRoutes } from './invitation-routes.ts';
import { createInvitationStore } from './invitation-store.ts';
import type { WorkspaceEnv } from './workspace-http.ts';
import { createWorkspaceRoutes } from './workspace-routes.ts';
import { createWorkspaceStore } from './workspace-store.ts';

export function createWorkspaceAccessRoutes({
  db,
  getUser,
  origin,
  sendEmail,
  reportError,
}: {
  db: Parameters<typeof createWorkspaceStore>[0];
  getUser: (headers: Headers) => Promise<SignedInUser | null>;
  origin: string;
  sendEmail: SendEmail | undefined;
  reportError: (error: unknown) => void;
}): Hono<WorkspaceEnv> {
  const workspaces = createWorkspaceStore(db);
  const invitations = createInvitationStore(db);
  const routes = new Hono<WorkspaceEnv>();

  routes.use('*', limitApiBody);

  routes.use('*', async (ctx, next) => {
    ctx.header('Cache-Control', 'no-store');
    ctx.header('Referrer-Policy', 'no-referrer');
    const method = ctx.req.method;
    if (method !== 'GET' && method !== 'HEAD' && ctx.req.header('Origin') !== origin)
      return errorResponse(ctx, 403, 'invalid_origin');

    const user = await getUser(ctx.req.raw.headers);
    if (!user) return errorResponse(ctx, 401, 'unauthenticated');

    ctx.set('user', user);
    await next();
  });

  routes.route('/', createInvitationRoutes({ invitations, origin, sendEmail, reportError }));

  routes.route('/', createWorkspaceRoutes(workspaces));

  return routes;
}
