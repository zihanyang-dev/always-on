import {
  AGENT_CONFIGURATION_SCHEMA,
  CREATE_SESSION_SCHEMA,
  SUBMIT_MESSAGE_SCHEMA,
} from '@always-on/contracts/agents';
import type { ModelCatalog } from '@always-on/contracts/models';
import { zValidator } from '@hono/zod-validator';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { isAvailableConfiguration } from '../agents/index.js';
import {
  type AuthenticatedRouter,
  createAuthenticatedRouter,
  type GetRequestUser,
  handleValidationResult,
} from '../api/index.js';
import type { Database } from '../infrastructure/database/index.js';
import { SESSION_CURSOR_SCHEMA } from './events.js';
import {
  cancelSessionRun,
  createAgentSession,
  readSessionRevision,
  readSessionSnapshot,
  submitSessionMessage,
  updateSessionConfiguration,
} from './store.js';
import { consumeSessionEvents } from './stream.js';

const SESSION_PATH_SCHEMA = z.object({ sessionId: z.uuid() });
const RUN_PATH_SCHEMA = SESSION_PATH_SCHEMA.extend({ runId: z.uuid() });

/** Owns authenticated conversation input and cancellation, independently of event subscriptions. */
export function createSessionRoutes({
  db,
  catalog,
  getUser,
  events,
}: {
  db: Database;
  catalog: ModelCatalog;
  getUser: GetRequestUser;
  events?: {
    readonly redisUrl: string;
    readonly prefix: string;
    readonly onError: (error: Error) => void;
  };
}): AuthenticatedRouter {
  const routes = createAuthenticatedRouter(getUser);
  if (events) {
    routes.get(
      '/:sessionId/events',
      zValidator('param', SESSION_PATH_SCHEMA, handleValidationResult),
      async (ctx) => {
        const cursor = SESSION_CURSOR_SCHEMA.safeParse(ctx.req.header('last-event-id') ?? '0-0');
        if (!cursor.success) return ctx.json({ code: 'invalid_cursor' }, 400);
        const access = {
          db,
          sessionId: ctx.req.valid('param').sessionId,
          userId: ctx.get('userId'),
        };
        if ((await readSessionRevision(access)) === null)
          return ctx.json({ code: 'not_found' }, 404);
        return streamSSE(
          ctx,
          (stream) =>
            consumeSessionEvents({
              stream,
              ...access,
              cursor: cursor.data,
              requestSignal: ctx.req.raw.signal,
              hasValidLogin,
              ...events,
            }),
          async (error, stream) => {
            if (stream.aborted || ctx.req.raw.signal.aborted) return;
            events.onError(error);
            await stream.writeSSE({ event: 'unavailable', data: '{"code":"stream_unavailable"}' });
          },
        );

        async function hasValidLogin() {
          return (await getUser(ctx.req.raw.headers))?.id === access.userId;
        }
      },
    );
  }
  routes.post(
    '/',
    zValidator('json', CREATE_SESSION_SCHEMA, handleValidationResult),
    async (ctx) => {
      const { agentId } = ctx.req.valid('json');
      const session = await createAgentSession({ db, agentId, userId: ctx.get('userId') });
      if (!session) return ctx.json({ code: 'not_found' }, 404);
      return ctx.json(session, 201);
    },
  );
  routes.get(
    '/:sessionId',
    zValidator('param', SESSION_PATH_SCHEMA, handleValidationResult),
    async (ctx) => {
      const { sessionId } = ctx.req.valid('param');
      const snapshot = await readSessionSnapshot({ db, sessionId, userId: ctx.get('userId') });
      if (!snapshot) return ctx.json({ code: 'not_found' }, 404);
      return ctx.json(snapshot);
    },
  );
  routes.patch(
    '/:sessionId/configuration',
    zValidator('param', SESSION_PATH_SCHEMA, handleValidationResult),
    zValidator('json', AGENT_CONFIGURATION_SCHEMA, handleValidationResult),
    async (ctx) => {
      const configuration = ctx.req.valid('json');
      if (!isAvailableConfiguration({ configuration, models: catalog.models }))
        return ctx.json({ code: 'unsupported_model_configuration' }, 400);
      const session = await updateSessionConfiguration({
        db,
        sessionId: ctx.req.valid('param').sessionId,
        userId: ctx.get('userId'),
        configuration,
      });
      if (!session) return ctx.json({ code: 'not_found' }, 404);
      return ctx.json(session);
    },
  );
  routes.post(
    '/:sessionId/messages',
    zValidator('param', SESSION_PATH_SCHEMA, handleValidationResult),
    zValidator('json', SUBMIT_MESSAGE_SCHEMA, handleValidationResult),
    async (ctx) => {
      const result = await submitSessionMessage({
        db,
        sessionId: ctx.req.valid('param').sessionId,
        userId: ctx.get('userId'),
        input: ctx.req.valid('json'),
      });
      switch (result.status) {
        case 'accepted':
          return ctx.json(result, 202);
        case 'duplicate':
          return ctx.json(result);
        case 'not_found':
          return ctx.json({ code: result.status }, 404);
        case 'conflict':
        case 'recovery_required':
          return ctx.json({ code: result.status }, 409);
        default: {
          const exhaustive: never = result;
          throw new Error(`Unexpected submission outcome ${JSON.stringify(exhaustive)}`);
        }
      }
    },
  );
  routes.post(
    '/:sessionId/runs/:runId/cancel',
    zValidator('param', RUN_PATH_SCHEMA, handleValidationResult),
    async (ctx) => {
      const { sessionId, runId } = ctx.req.valid('param');
      const run = await cancelSessionRun({ db, sessionId, runId, userId: ctx.get('userId') });
      if (!run) return ctx.json({ code: 'not_found' }, 404);
      return ctx.json(run);
    },
  );
  return routes;
}
