import {
  AGENT_CONFIGURATION_SCHEMA,
  CREATE_SESSION_SCHEMA,
  SESSION_HISTORY_QUERY_SCHEMA,
  SESSION_LIST_QUERY_SCHEMA,
  SUBMIT_MESSAGE_SCHEMA,
  UPDATE_SESSION_SCHEMA,
} from '@always-on/contracts/agents';
import type { ModelCatalog } from '@always-on/contracts/models';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { isAvailableConfiguration } from '../agents/index.js';
import {
  type AuthenticatedContext,
  type AuthenticatedRouter,
  createAuthenticatedRouter,
  type GetRequestUser,
  handleValidationResult,
} from '../api/index.js';
import type { Database } from '../infrastructure/database/index.js';
import { readSessionDeletion, requestSessionDeletion } from './deletion.js';
import { SESSION_CURSOR_SCHEMA } from './events.js';
import {
  listAgentSessions,
  readSessionHistory,
  readSessionRevision,
  readSessionSnapshot,
} from './queries.js';
import {
  cancelSessionRun,
  createAgentSession,
  submitSessionMessage,
  updateAgentSession,
  updateSessionConfiguration,
} from './store.js';
import { type SessionStreamConnection, streamSessionEvents } from './stream.js';

const SESSION_PATH_SCHEMA = z.object({ sessionId: z.uuid() });
const RUN_PATH_SCHEMA = SESSION_PATH_SCHEMA.extend({ runId: z.uuid() });
const VALIDATE_SESSION = zValidator('param', SESSION_PATH_SCHEMA, handleValidationResult);

type SessionPath = z.infer<typeof SESSION_PATH_SCHEMA>;
type SessionContext = AuthenticatedContext<{ param: SessionPath }>;
type CreateContext = AuthenticatedContext<{ json: z.infer<typeof CREATE_SESSION_SCHEMA> }>;
type MetadataContext = AuthenticatedContext<{
  param: SessionPath;
  json: z.infer<typeof UPDATE_SESSION_SCHEMA>;
}>;
type ListContext = AuthenticatedContext<{ query: z.infer<typeof SESSION_LIST_QUERY_SCHEMA> }>;
type HistoryContext = AuthenticatedContext<{
  param: SessionPath;
  query: z.infer<typeof SESSION_HISTORY_QUERY_SCHEMA>;
}>;
type ConfigureContext = AuthenticatedContext<{
  param: SessionPath;
  json: z.infer<typeof AGENT_CONFIGURATION_SCHEMA>;
}>;
type SubmitContext = AuthenticatedContext<{
  param: SessionPath;
  json: z.infer<typeof SUBMIT_MESSAGE_SCHEMA>;
}>;
type CancelContext = AuthenticatedContext<{ param: z.infer<typeof RUN_PATH_SCHEMA> }>;

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
  routes.get('/', zValidator('query', SESSION_LIST_QUERY_SCHEMA, handleValidationResult), list);
  routes.post('/', zValidator('json', CREATE_SESSION_SCHEMA, handleValidationResult), create);
  routes.get('/:sessionId', VALIDATE_SESSION, read);
  routes.patch(
    '/:sessionId',
    VALIDATE_SESSION,
    zValidator('json', UPDATE_SESSION_SCHEMA, handleValidationResult),
    updateMetadata,
  );
  routes.delete('/:sessionId', VALIDATE_SESSION, remove);
  routes.get('/:sessionId/deletion', VALIDATE_SESSION, readDeletion);
  routes.get(
    '/:sessionId/messages',
    VALIDATE_SESSION,
    zValidator('query', SESSION_HISTORY_QUERY_SCHEMA, handleValidationResult),
    history,
  );
  routes.patch(
    '/:sessionId/configuration',
    VALIDATE_SESSION,
    zValidator('json', AGENT_CONFIGURATION_SCHEMA, handleValidationResult),
    configure,
  );
  routes.post(
    '/:sessionId/messages',
    VALIDATE_SESSION,
    zValidator('json', SUBMIT_MESSAGE_SCHEMA, handleValidationResult),
    submit,
  );
  routes.post(
    '/:sessionId/runs/:runId/cancel',
    zValidator('param', RUN_PATH_SCHEMA, handleValidationResult),
    cancel,
  );
  if (events) routes.get('/:sessionId/events', VALIDATE_SESSION, (ctx) => subscribe(ctx, events));

  return routes;

  async function list(ctx: ListContext) {
    const result = await listAgentSessions({
      db,
      userId: ctx.get('userId'),
      query: ctx.req.valid('query'),
    });
    switch (result.status) {
      case 'found':
        return ctx.json(result.page);
      case 'not_found':
        return ctx.json({ code: result.status }, 404);
      case 'invalid_cursor':
        return ctx.json({ code: result.status }, 400);
      default: {
        const exhaustive: never = result;
        throw new Error(`Unexpected Session list outcome ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  async function history(ctx: HistoryContext) {
    const result = await readSessionHistory({
      db,
      sessionId: ctx.req.valid('param').sessionId,
      userId: ctx.get('userId'),
      query: ctx.req.valid('query'),
    });
    switch (result.status) {
      case 'found':
        return ctx.json(result.page);
      case 'not_found':
        return ctx.json({ code: result.status }, 404);
      case 'invalid_cursor':
        return ctx.json({ code: result.status }, 400);
      default: {
        const exhaustive: never = result;
        throw new Error(`Unexpected Session history outcome ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  async function create(ctx: CreateContext) {
    const { agentId } = ctx.req.valid('json');
    const session = await createAgentSession({ db, agentId, userId: ctx.get('userId') });
    if (!session) return ctx.json({ code: 'not_found' }, 404);

    return ctx.json(session, 201);
  }

  async function read(ctx: SessionContext) {
    const { sessionId } = ctx.req.valid('param');
    const snapshot = await readSessionSnapshot({ db, sessionId, userId: ctx.get('userId') });
    if (!snapshot) return ctx.json({ code: 'not_found' }, 404);

    return ctx.json(snapshot);
  }

  async function configure(ctx: ConfigureContext) {
    const configuration = ctx.req.valid('json');
    // A valid effort string may still be unsupported by this particular provider and model.
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
  }

  async function updateMetadata(ctx: MetadataContext) {
    const session = await updateAgentSession({
      db,
      sessionId: ctx.req.valid('param').sessionId,
      userId: ctx.get('userId'),
      patch: ctx.req.valid('json'),
    });
    if (!session) return ctx.json({ code: 'not_found' }, 404);

    return ctx.json(session);
  }

  async function remove(ctx: SessionContext) {
    const result = await requestSessionDeletion({
      db,
      sessionId: ctx.req.valid('param').sessionId,
      userId: ctx.get('userId'),
    });
    switch (result.status) {
      case 'accepted':
        return ctx.json(result.deletion, 202);
      case 'not_found':
        return ctx.json({ code: result.status }, 404);
      case 'busy':
      case 'recovery_required':
        return ctx.json({ code: result.status }, 409);
      default: {
        const exhaustive: never = result;
        throw new Error(`Unexpected Session deletion outcome ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  async function readDeletion(ctx: SessionContext) {
    const deletion = await readSessionDeletion({
      db,
      sessionId: ctx.req.valid('param').sessionId,
      userId: ctx.get('userId'),
    });
    if (!deletion) return ctx.json({ code: 'not_found' }, 404);

    return ctx.json(deletion);
  }

  async function submit(ctx: SubmitContext) {
    // A lost HTTP response must not create another Run; retries reuse the committed source ID.
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
  }

  async function cancel(ctx: CancelContext) {
    // Persist intent so cancellation survives a dropped HTTP response or a Worker restart.
    const { sessionId, runId } = ctx.req.valid('param');
    const run = await cancelSessionRun({ db, sessionId, runId, userId: ctx.get('userId') });
    if (!run) return ctx.json({ code: 'not_found' }, 404);

    return ctx.json(run);
  }

  async function subscribe(ctx: SessionContext, connection: SessionStreamConnection) {
    const cursor = SESSION_CURSOR_SCHEMA.safeParse(ctx.req.header('last-event-id') ?? '0-0');
    if (!cursor.success) return ctx.json({ code: 'invalid_cursor' }, 400);

    const access = { db, sessionId: ctx.req.valid('param').sessionId, userId: ctx.get('userId') };
    if ((await readSessionRevision(access)) === null) return ctx.json({ code: 'not_found' }, 404);

    // Each heartbeat checks the original login as well as current resource membership.
    const headers = ctx.req.raw.headers;
    const hasValidLogin = async () => (await getUser(headers))?.id === access.userId;

    return streamSessionEvents(ctx, {
      ...access,
      cursor: cursor.data,
      connection,
      hasValidLogin,
    });
  }
}
