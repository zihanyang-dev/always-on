import { zValidator } from '@hono/zod-validator';
import { type Context, Hono, type Next } from 'hono';
import { z } from 'zod';
import type { SignedInUser } from '../../access/index.ts';
import { errorResponse, invalidInput, limitApiBody } from '../../http/index.ts';
import type { WorkStore } from './work-store.ts';

const WORKSPACE = z.object({ workspaceId: z.uuid() });
const WORK = WORKSPACE.extend({ workId: z.uuid() });
const RECEIPT = WORKSPACE.extend({ eventId: z.uuid() });
const MAX_CONVERSATION_ID_BYTES = 2400;
const THREAD = z.object({
  connectionId: z.uuid(),
  conversationId: z
    .string()
    .min(1)
    .max(1000)
    .refine(
      (id) =>
        id.isWellFormed() &&
        !id.includes('\u0000') &&
        Buffer.byteLength(id, 'utf8') <= MAX_CONVERSATION_ID_BYTES,
    ),
});

const ERRORS = { not_found: 404, forbidden: 403, thread_already_bound: 409 } as const;
type WorkEnv = { Variables: { user: SignedInUser } };
type WorkContext<T extends object> = Context<WorkEnv, string, { out: T }>;

type WorkRoutes = {
  work: WorkStore;
  origin: string;
  getUser: (headers: Headers) => Promise<SignedInUser | null>;
  findConnectionWorkspace: (connectionId: string) => Promise<string | null>;
};

export function createWorkRoutes({
  work,
  origin,
  getUser,
  findConnectionWorkspace,
}: WorkRoutes): Hono<WorkEnv> {
  const routes = new Hono<WorkEnv>();
  const workParam = zValidator('param', WORK, invalidInput);
  routes.use('*', requireUser);

  routes.get(
    '/:workspaceId/receipts/:eventId',
    zValidator('param', RECEIPT, invalidInput),
    readRouting,
  );

  routes.get('/:workspaceId/:workId', workParam, readWork);

  routes.post(
    '/:workspaceId/:workId/threads',
    limitApiBody,
    workParam,
    zValidator('json', THREAD, invalidInput),
    bindThread,
  );

  return routes;

  async function requireUser(ctx: Context<WorkEnv>, next: Next) {
    ctx.header('Cache-Control', 'no-store');
    const method = ctx.req.method;
    if (method !== 'GET' && method !== 'HEAD' && ctx.req.header('Origin') !== origin)
      return errorResponse(ctx, 403, 'invalid_origin');

    const user = await getUser(ctx.req.raw.headers);
    if (!user) return errorResponse(ctx, 401, 'unauthenticated');

    ctx.set('user', user);
    await next();
  }

  async function readRouting(ctx: WorkContext<{ param: z.output<typeof RECEIPT> }>) {
    const result = await work.messageRouting({
      ...ctx.req.valid('param'),
      userId: ctx.get('user').id,
    });
    if (result.status !== 'found') return errorResponse(ctx, ERRORS[result.status], result.status);

    return ctx.json(result.value);
  }

  async function readWork(ctx: WorkContext<{ param: z.output<typeof WORK> }>) {
    const result = await work.read({ ...ctx.req.valid('param'), userId: ctx.get('user').id });
    if (result.status !== 'found') return errorResponse(ctx, ERRORS[result.status], result.status);

    return ctx.json({ work: result.value });
  }

  async function bindThread(
    ctx: WorkContext<{ param: z.output<typeof WORK>; json: z.output<typeof THREAD> }>,
  ) {
    const { workspaceId, workId } = ctx.req.valid('param');
    const thread = ctx.req.valid('json');
    const connectionWorkspace = await findConnectionWorkspace(thread.connectionId);
    if (connectionWorkspace !== workspaceId) return errorResponse(ctx, 404, 'not_found');

    const result = await work.bindThread({
      ...thread,
      workspaceId,
      workId,
      userId: ctx.get('user').id,
    });
    if (result !== 'bound') return errorResponse(ctx, ERRORS[result], result);

    return ctx.body(null, 204);
  }
}
