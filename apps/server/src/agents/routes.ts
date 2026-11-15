import { CREATE_AGENT_SCHEMA } from '@always-on/contracts/agents';
import type { ModelCatalog } from '@always-on/contracts/models';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  type AuthenticatedRouter,
  createAuthenticatedRouter,
  type GetRequestUser,
  handleValidationResult,
} from '../api/index.js';
import type { Database } from '../infrastructure/database/index.js';
import { createAgent, isAvailableConfiguration, listAgents } from './store.js';

const WORKSPACE_QUERY_SCHEMA = z.string().trim().min(1).max(200);

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
  routes.get('/', async (ctx) => {
    const workspaceId = WORKSPACE_QUERY_SCHEMA.safeParse(ctx.req.query('workspaceId'));
    if (!workspaceId.success) return ctx.json({ code: 'invalid_workspace_id' }, 400);
    const agents = await listAgents({
      db,
      workspaceId: workspaceId.data,
      userId: ctx.get('userId'),
    });
    if (!agents) return ctx.json({ code: 'not_found' }, 404);
    return ctx.json({ agents });
  });
  routes.post('/', zValidator('json', CREATE_AGENT_SCHEMA, handleValidationResult), async (ctx) => {
    const input = ctx.req.valid('json');
    if (!isAvailableConfiguration({ configuration: input, models: catalog.models }))
      return ctx.json({ code: 'unsupported_model_configuration' }, 400);
    const agent = await createAgent({ db, userId: ctx.get('userId'), input });
    if (!agent) return ctx.json({ code: 'forbidden' }, 403);
    return ctx.json(agent, 201);
  });
  return routes;
}
