import {
  AGENT_CONFIGURATION_SCHEMA,
  CREATE_SESSION_SCHEMA,
  SUBMIT_MESSAGE_SCHEMA,
} from '@always-on/contracts/agents';
import type { ModelCatalog } from '@always-on/contracts/models';
import { zValidator } from '@hono/zod-validator';
import { createFactory } from 'hono/factory';
import { z } from 'zod';
import { isAvailableConfiguration } from '../agents/index.js';
import {
  type AuthenticatedApiEnv,
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
import { type SessionStreamConnection, streamSessionEvents } from './stream.js';

const SESSION_PATH_SCHEMA = z.object({ sessionId: z.uuid() });
const RUN_PATH_SCHEMA = SESSION_PATH_SCHEMA.extend({ runId: z.uuid() });
const SESSION_API = createFactory<AuthenticatedApiEnv>();
const VALIDATE_SESSION = zValidator('param', SESSION_PATH_SCHEMA, handleValidationResult);

type SessionRoutesOptions = {
  db: Database;
  catalog: ModelCatalog;
  getUser: GetRequestUser;
  events?: SessionStreamConnection;
};

/** Registers authenticated Session operations and the optional event subscription. */
export function createSessionRoutes({
  db,
  catalog,
  getUser,
  events,
}: SessionRoutesOptions): AuthenticatedRouter {
  const routes = createAuthenticatedRouter(getUser);
  const handlers = createSessionHandlers({ db, models: catalog.models });
  routes.post('/', ...handlers.create);
  routes.get('/:sessionId', ...handlers.read);
  routes.patch('/:sessionId/configuration', ...handlers.configure);
  routes.post('/:sessionId/messages', ...handlers.submit);
  routes.post('/:sessionId/runs/:runId/cancel', ...handlers.cancel);
  if (events) routes.get('/:sessionId/events', ...createEventHandlers(events));
  return routes;

  function createEventHandlers(connection: SessionStreamConnection) {
    return SESSION_API.createHandlers(VALIDATE_SESSION, async function subscribe(ctx) {
      const cursor = SESSION_CURSOR_SCHEMA.safeParse(ctx.req.header('last-event-id') ?? '0-0');
      if (!cursor.success) return ctx.json({ code: 'invalid_cursor' }, 400);
      const access = {
        db,
        sessionId: ctx.req.valid('param').sessionId,
        userId: ctx.get('userId'),
      };
      if ((await readSessionRevision(access)) === null) return ctx.json({ code: 'not_found' }, 404);
      return streamSessionEvents(ctx, {
        ...access,
        cursor: cursor.data,
        connection,
        hasValidLogin,
      });

      async function hasValidLogin() {
        return (await getUser(ctx.req.raw.headers))?.id === access.userId;
      }
    });
  }
}

function createSessionHandlers({ db, models }: { db: Database; models: ModelCatalog['models'] }) {
  // Hono's factory keeps validated input types attached to the handlers when registration is separate.
  const create = SESSION_API.createHandlers(
    zValidator('json', CREATE_SESSION_SCHEMA, handleValidationResult),
    async function createSession(ctx) {
      const { agentId } = ctx.req.valid('json');
      const session = await createAgentSession({ db, agentId, userId: ctx.get('userId') });
      if (!session) return ctx.json({ code: 'not_found' }, 404);
      return ctx.json(session, 201);
    },
  );
  const read = SESSION_API.createHandlers(VALIDATE_SESSION, async function readSession(ctx) {
    const { sessionId } = ctx.req.valid('param');
    const snapshot = await readSessionSnapshot({ db, sessionId, userId: ctx.get('userId') });
    if (!snapshot) return ctx.json({ code: 'not_found' }, 404);
    return ctx.json(snapshot);
  });
  const configure = SESSION_API.createHandlers(
    VALIDATE_SESSION,
    zValidator('json', AGENT_CONFIGURATION_SCHEMA, handleValidationResult),
    async function configureSession(ctx) {
      const configuration = ctx.req.valid('json');
      if (!isAvailableConfiguration({ configuration, models }))
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
  const submit = SESSION_API.createHandlers(
    VALIDATE_SESSION,
    zValidator('json', SUBMIT_MESSAGE_SCHEMA, handleValidationResult),
    async function submitMessage(ctx) {
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
  const cancel = SESSION_API.createHandlers(
    zValidator('param', RUN_PATH_SCHEMA, handleValidationResult),
    async function cancelRun(ctx) {
      const { sessionId, runId } = ctx.req.valid('param');
      const run = await cancelSessionRun({ db, sessionId, runId, userId: ctx.get('userId') });
      if (!run) return ctx.json({ code: 'not_found' }, 404);
      return ctx.json(run);
    },
  );
  return { create, read, configure, submit, cancel };
}
