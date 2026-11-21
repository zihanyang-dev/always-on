import { Hono } from 'hono';
import { errorResponse, type HttpEnv, limitApiBody } from '../http/index.ts';
import type { SendEmail } from '../infrastructure/index.ts';
import { type AuthenticationConfig, createAuthentication } from './authentication/index.ts';
import { createWorkspaceAccessRoutes } from './workspaces/index.ts';

export type {
  AuthenticationConfig,
  OAuthCredentials,
  SignedInUser,
} from './authentication/index.ts';
export { authorizeMessageSubmission } from './workspaces/index.ts';

export type AccessOptions = {
  db: Parameters<typeof createWorkspaceAccessRoutes>[0]['db'];
  config: AuthenticationConfig;
  sendEmail: SendEmail | undefined;
  reportError: (error: unknown) => void;
};

/** Composes application identity and Workspace access. */
export function createAccess({ db, config, sendEmail, reportError }: AccessOptions): {
  routes: Hono<HttpEnv>;
  getUser: ReturnType<typeof createAuthentication>['getUser'];
} {
  const auth = createAuthentication({ db, config, sendEmail });
  const workspaces = createWorkspaceAccessRoutes({
    db,
    getUser: auth.getUser,
    origin: config.origin,
    sendEmail,
    reportError,
  });

  const routes = new Hono<HttpEnv>();

  routes.use('/auth/*', limitApiBody);

  routes.get('/login-methods', (ctx) => ctx.json({ methods: auth.loginMethods }));

  routes.get('/me', async (ctx) => {
    ctx.header('Cache-Control', 'no-store');
    const user = await auth.getUser(ctx.req.raw.headers);
    return user ? ctx.json({ user }) : errorResponse(ctx, 401, 'unauthenticated');
  });

  routes.all('/auth/*', (ctx) =>
    auth.handle({ request: ctx.req.raw, clientIp: ctx.env?.incoming?.socket.remoteAddress }),
  );

  routes.route('/workspaces', workspaces);

  return { routes, getUser: auth.getUser };
}
