import { zValidator } from '@hono/zod-validator';
import { type Context, type Env, Hono } from 'hono';
import { z } from 'zod';
import { errorResponse, invalidInput, limitApiBody } from '../../http/index.ts';
import type { Inbox } from '../../work/index.ts';
import { readWebhookEvent } from './webhook-event.ts';

type WebhookConnection = { workspaceId: string; signingSecret: string };
export type FindWebhookConnection = (connectionId: string) => Promise<WebhookConnection | null>;

const CONNECTION = z.object({ connectionId: z.uuid() });
type ReceiveContext = Context<Env, string, { out: { param: z.output<typeof CONNECTION> } }>;
const WEBHOOK_ERROR_STATUS = { invalid_input: 400, invalid_signature: 401 } as const;

export function createWebhookRoutes({
  findConnection,
  acceptEvent,
}: {
  findConnection: FindWebhookConnection;
  acceptEvent: Inbox['acceptChannelEvent'];
}): Hono {
  const routes = new Hono();
  const connectionParam = zValidator('param', CONNECTION, invalidInput);
  routes.post('/:connectionId', limitApiBody, connectionParam, receiveWebhook);

  return routes;

  async function receiveWebhook(ctx: ReceiveContext) {
    const { connectionId } = ctx.req.valid('param');
    const connection = await findConnection(connectionId);
    if (!connection) return errorResponse(ctx, 404, 'not_found');

    const body = new Uint8Array(await ctx.req.arrayBuffer());
    const delivery = readWebhookEvent({
      body,
      headers: ctx.req.raw.headers,
      signingSecret: connection.signingSecret,
    });
    if (!delivery.ok)
      return errorResponse(ctx, WEBHOOK_ERROR_STATUS[delivery.error], delivery.error);

    const receipt = await acceptEvent({
      ...delivery.event,
      connectionId,
      workspaceId: connection.workspaceId,
    });
    if (receipt.status !== 'accepted') return errorResponse(ctx, 409, receipt.status);

    return ctx.json({ eventId: receipt.eventId, duplicate: receipt.duplicate }, 202);
  }
}
