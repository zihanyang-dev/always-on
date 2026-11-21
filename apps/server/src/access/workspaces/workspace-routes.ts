import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { invalidInput } from '../../http/index.ts';
import type { PageRequest } from './page.ts';
import { WORKSPACE_ROLES } from './workspace.ts';
import {
  MEMBER_ID,
  MEMBER_PAGE_QUERY,
  requireVerifiedEmail,
  WORKSPACE_ID,
  WORKSPACE_NAME,
  WORKSPACE_PAGE_QUERY,
  type WorkspaceContext,
  type WorkspaceEnv,
  type WorkspaceParams,
  workspaceError,
} from './workspace-http.ts';
import type { WorkspaceStore } from './workspace-store.ts';

const ROLE = z.object({ role: z.enum(WORKSPACE_ROLES) });

type WorkspaceName = z.output<typeof WORKSPACE_NAME>;
type MemberParams = z.output<typeof MEMBER_ID>;

export function createWorkspaceRoutes(workspaces: WorkspaceStore): Hono<WorkspaceEnv> {
  const routes = new Hono<WorkspaceEnv>();
  const workspaceId = zValidator('param', WORKSPACE_ID, invalidInput);
  const memberId = zValidator('param', MEMBER_ID, invalidInput);
  const workspaceName = zValidator('json', WORKSPACE_NAME, invalidInput);

  routes.get('/', zValidator('query', WORKSPACE_PAGE_QUERY, invalidInput), listWorkspaces);

  routes.post('/', requireVerifiedEmail, workspaceName, createWorkspace);

  routes.get('/:workspaceId', workspaceId, getWorkspace);

  routes.patch('/:workspaceId', workspaceId, workspaceName, renameWorkspace);

  routes.get(
    '/:workspaceId/members',
    workspaceId,
    zValidator('query', MEMBER_PAGE_QUERY, invalidInput),
    listMembers,
  );

  routes.patch(
    '/:workspaceId/members/:memberUserId',
    memberId,
    zValidator('json', ROLE, invalidInput),
    changeRole,
  );

  routes.delete('/:workspaceId/members/:memberUserId', memberId, removeMember);

  routes.delete('/:workspaceId/membership', workspaceId, leaveWorkspace);

  return routes;

  async function listWorkspaces(ctx: WorkspaceContext<{ query: PageRequest }>) {
    const page = await workspaces.list({
      userId: ctx.get('user').id,
      page: ctx.req.valid('query'),
    });
    return ctx.json({ workspaces: page.items, nextCursor: page.nextCursor });
  }

  async function createWorkspace(ctx: WorkspaceContext<{ json: WorkspaceName }>) {
    const { name } = ctx.req.valid('json');
    const workspace = await workspaces.create({ name, userId: ctx.get('user').id });
    return ctx.json({ workspace }, 201);
  }

  async function getWorkspace(ctx: WorkspaceContext<{ param: WorkspaceParams }>) {
    const { workspaceId } = ctx.req.valid('param');
    const workspace = await workspaces.get({ workspaceId, userId: ctx.get('user').id });
    return workspace ? ctx.json({ workspace }) : workspaceError(ctx, 'not_found');
  }

  async function renameWorkspace(
    ctx: WorkspaceContext<{ param: WorkspaceParams; json: WorkspaceName }>,
  ) {
    const { workspaceId } = ctx.req.valid('param');
    const { name } = ctx.req.valid('json');
    const result = await workspaces.rename({ workspaceId, name, userId: ctx.get('user').id });
    return result.ok ? ctx.json({ workspace: result.value }) : workspaceError(ctx, result.error);
  }

  async function listMembers(
    ctx: WorkspaceContext<{ param: WorkspaceParams; query: PageRequest }>,
  ) {
    const { workspaceId } = ctx.req.valid('param');
    const result = await workspaces.listMembers({
      workspaceId,
      userId: ctx.get('user').id,
      page: ctx.req.valid('query'),
    });
    if (!result.ok) return workspaceError(ctx, result.error);

    const { items, nextCursor } = result.value;
    return ctx.json({ members: items, nextCursor });
  }

  async function changeRole(
    ctx: WorkspaceContext<{ param: MemberParams; json: z.output<typeof ROLE> }>,
  ) {
    const { workspaceId, memberUserId } = ctx.req.valid('param');
    const { role } = ctx.req.valid('json');
    const result = await workspaces.changeMemberRole({
      workspaceId,
      memberUserId,
      nextRole: role,
      userId: ctx.get('user').id,
    });
    return result.ok ? ctx.body(null, 204) : workspaceError(ctx, result.error);
  }

  async function removeMember(ctx: WorkspaceContext<{ param: MemberParams }>) {
    const { workspaceId, memberUserId } = ctx.req.valid('param');
    const result = await workspaces.removeMember({
      workspaceId,
      memberUserId,
      userId: ctx.get('user').id,
    });
    return result.ok ? ctx.body(null, 204) : workspaceError(ctx, result.error);
  }

  async function leaveWorkspace(ctx: WorkspaceContext<{ param: WorkspaceParams }>) {
    const { workspaceId } = ctx.req.valid('param');
    const result = await workspaces.leave({ workspaceId, userId: ctx.get('user').id });
    return result.ok ? ctx.body(null, 204) : workspaceError(ctx, result.error);
  }
}
