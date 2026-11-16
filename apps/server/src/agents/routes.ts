import { CREATE_AGENT_SCHEMA, UPDATE_AGENT_SCHEMA } from '@always-on/contracts/agents';
import type { ModelCatalog } from '@always-on/contracts/models';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  type AuthenticatedContext,
  type AuthenticatedRouter,
  createAuthenticatedRouter,
  type GetRequestUser,
  handleValidationResult,
} from '../api/index.js';
import type { Database } from '../infrastructure/database/index.js';
import {
  createAgent,
  deleteAgent,
  isAvailableConfiguration,
  listAgents,
  updateAgent,
} from './store.js';

const WORKSPACE_QUERY_SCHEMA = z.string().trim().min(1).max(200);
const AGENT_PATH_SCHEMA = z.object({ agentId: z.uuid() });
const VALIDATE_AGENT = zValidator('param', AGENT_PATH_SCHEMA, handleValidationResult);
type CreateContext = AuthenticatedContext<{ json: z.infer<typeof CREATE_AGENT_SCHEMA> }>;
type AgentContext = AuthenticatedContext<{ param: z.infer<typeof AGENT_PATH_SCHEMA> }>;
type UpdateContext = AuthenticatedContext<{
  param: z.infer<typeof AGENT_PATH_SCHEMA>;
  json: z.infer<typeof UPDATE_AGENT_SCHEMA>;
}>;

/** Exposes workspace-scoped Agent definitions and the enabled model catalogue. */
export function createAgentRoutes({
  db,
  catalog,
  getUser,
}: {
  db: Database;
  catalog: ModelCatalog;
  getUser: GetRequestUser;
}): AuthenticatedRouter {
  const routes = createAuthenticatedRouter(getUser);
  routes.get('/models', (ctx) => ctx.json(catalog));
  routes.get('/', list);
  routes.post('/', zValidator('json', CREATE_AGENT_SCHEMA, handleValidationResult), create);
  routes.patch(
    '/:agentId',
    VALIDATE_AGENT,
    zValidator('json', UPDATE_AGENT_SCHEMA, handleValidationResult),
    update,
  );
  routes.delete('/:agentId', VALIDATE_AGENT, remove);

  return routes;

  async function list(ctx: AuthenticatedContext) {
    const workspaceId = WORKSPACE_QUERY_SCHEMA.safeParse(ctx.req.query('workspaceId'));
    if (!workspaceId.success) return ctx.json({ code: 'invalid_workspace_id' }, 400);

    const agents = await listAgents({
      db,
      workspaceId: workspaceId.data,
      userId: ctx.get('userId'),
    });
    if (!agents) return ctx.json({ code: 'not_found' }, 404);

    return ctx.json({ agents });
  }

  async function create(ctx: CreateContext) {
    const input = ctx.req.valid('json');
    if (!isAvailableConfiguration({ configuration: input, models: catalog.models }))
      return ctx.json({ code: 'unsupported_model_configuration' }, 400);

    const agent = await createAgent({ db, userId: ctx.get('userId'), input });
    if (!agent) return ctx.json({ code: 'forbidden' }, 403);

    return ctx.json(agent, 201);
  }

  async function update(ctx: UpdateContext) {
    const result = await updateAgent({
      db,
      agentId: ctx.req.valid('param').agentId,
      userId: ctx.get('userId'),
      patch: ctx.req.valid('json'),
      models: catalog.models,
    });
    switch (result.status) {
      case 'updated':
        return ctx.json(result.agent);
      case 'not_found':
        return ctx.json({ code: result.status }, 404);
      case 'unsupported_model_configuration':
        return ctx.json({ code: result.status }, 400);
      default: {
        const exhaustive: never = result;
        throw new Error(`Unexpected Agent update outcome ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  async function remove(ctx: AgentContext) {
    const status = await deleteAgent({
      db,
      agentId: ctx.req.valid('param').agentId,
      userId: ctx.get('userId'),
    });
    switch (status) {
      case 'deleted':
        return ctx.body(null, 204);
      case 'not_found':
        return ctx.json({ code: status }, 404);
      case 'has_sessions':
        return ctx.json({ code: status }, 409);
      default: {
        const exhaustive: never = status;
        throw new Error(`Unexpected Agent deletion outcome ${exhaustive}`);
      }
    }
  }
}
