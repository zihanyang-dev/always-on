import { zValidator } from '@hono/zod-validator';
import { type Context, type Env, Hono } from 'hono';
import { z } from 'zod';
import type { SignedInUser } from '../../access/index.ts';
import { errorResponse, invalidInput, limitApiBody } from '../../http/index.ts';
import type { Inbox } from './inbox-event.ts';
import { MESSAGE_CONTENT } from './inbox-message.ts';

const WORKSPACE_ID = z.object({ workspaceId: z.uuid() });
const MESSAGE = MESSAGE_CONTENT.extend({ clientMessageId: z.uuid() });
type MessageContext = Context<
  Env,
  string,
  {
    out: { param: z.output<typeof WORKSPACE_ID>; json: z.output<typeof MESSAGE> };
  }
>;
const MESSAGE_ERROR_STATUS = { not_found: 404, forbidden: 403, event_id_conflict: 409 } as const;

export function createInboxRoutes({
  inbox,
  origin,
  getUser,
}: {
  inbox: Pick<Inbox, 'acceptUserMessage'>;
  origin: string;
  getUser: (headers: Headers) => Promise<SignedInUser | null>;
}): Hono {
  const routes = new Hono();
  const workspaceParam = zValidator('param', WORKSPACE_ID, invalidInput);
  const messageBody = zValidator('json', MESSAGE, invalidInput);

  routes.post(
    '/inbox/:workspaceId/messages',
    limitApiBody,
    workspaceParam,
    messageBody,
    receiveMessage,
  );

  return routes;

  async function receiveMessage(ctx: MessageContext) {
    ctx.header('Cache-Control', 'no-store');
    if (ctx.req.header('Origin') !== origin) return errorResponse(ctx, 403, 'invalid_origin');

    const user = await getUser(ctx.req.raw.headers);
    if (!user) return errorResponse(ctx, 401, 'unauthenticated');

    const { workspaceId } = ctx.req.valid('param');
    const { clientMessageId, text, target } = ctx.req.valid('json');
    const receipt = await inbox.acceptUserMessage({
      workspaceId,
      userId: user.id,
      clientMessageId,
      text,
      target,
    });
    if (receipt.status !== 'accepted')
      return errorResponse(ctx, MESSAGE_ERROR_STATUS[receipt.status], receipt.status);

    return ctx.json({ eventId: receipt.eventId, duplicate: receipt.duplicate }, 202);
  }
}
