import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { errorResponse, invalidInput } from '../../http/index.ts';
import type { SendEmail } from '../../infrastructure/index.ts';
import type { InvitationStore } from './invitation-store.ts';
import type { PageRequest } from './page.ts';
import { INVITATION_ROLES } from './workspace.ts';
import {
  requireVerifiedEmail,
  WORKSPACE_ID,
  WORKSPACE_PAGE_QUERY,
  type WorkspaceContext,
  type WorkspaceEnv,
  type WorkspaceParams,
  workspaceError,
} from './workspace-http.ts';

const INVITATION_ID = WORKSPACE_ID.extend({ invitationId: z.uuid() });
const ISSUE = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: z.enum(INVITATION_ROLES),
});
const TOKEN = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
type InvitationToken = z.output<typeof TOKEN>;

export function createInvitationRoutes({
  invitations,
  origin,
  sendEmail,
  reportError,
}: {
  invitations: InvitationStore;
  origin: string;
  sendEmail: SendEmail | undefined;
  reportError: (error: unknown) => void;
}): Hono<WorkspaceEnv> {
  const routes = new Hono<WorkspaceEnv>();
  const workspaceId = zValidator('param', WORKSPACE_ID, invalidInput);
  const tokenBody = zValidator('json', TOKEN, invalidInput);

  routes.get(
    '/invitations/review',
    requireVerifiedEmail,
    zValidator('query', TOKEN, invalidInput),
    reviewInvitation,
  );

  routes.post('/invitations/accept', requireVerifiedEmail, tokenBody, acceptInvitation);

  routes.post('/invitations/reject', requireVerifiedEmail, tokenBody, rejectInvitation);

  routes.get(
    '/:workspaceId/invitations',
    workspaceId,
    zValidator('query', WORKSPACE_PAGE_QUERY, invalidInput),
    listInvitations,
  );

  routes.post(
    '/:workspaceId/invitations',
    workspaceId,
    zValidator('json', ISSUE, invalidInput),
    issueInvitation,
  );

  routes.delete(
    '/:workspaceId/invitations/:invitationId',
    zValidator('param', INVITATION_ID, invalidInput),
    cancelInvitation,
  );

  return routes;

  async function reviewInvitation(ctx: WorkspaceContext<{ query: InvitationToken }>) {
    const result = await invitations.review({
      email: ctx.get('user').email,
      token: ctx.req.valid('query').token,
    });
    return result.ok ? ctx.json({ invitation: result.value }) : workspaceError(ctx, result.error);
  }

  async function acceptInvitation(ctx: WorkspaceContext<{ json: InvitationToken }>) {
    const { id, email } = ctx.get('user');
    const result = await invitations.accept({
      userId: id,
      email,
      token: ctx.req.valid('json').token,
    });
    return result.ok ? ctx.json({ membership: result.value }) : workspaceError(ctx, result.error);
  }

  async function rejectInvitation(ctx: WorkspaceContext<{ json: InvitationToken }>) {
    const { id, email } = ctx.get('user');
    const result = await invitations.reject({
      userId: id,
      email,
      token: ctx.req.valid('json').token,
    });
    return result.ok ? ctx.body(null, 204) : workspaceError(ctx, result.error);
  }

  async function listInvitations(
    ctx: WorkspaceContext<{ param: WorkspaceParams; query: PageRequest }>,
  ) {
    const { workspaceId } = ctx.req.valid('param');
    const result = await invitations.list({
      workspaceId,
      userId: ctx.get('user').id,
      page: ctx.req.valid('query'),
    });
    if (!result.ok) return workspaceError(ctx, result.error);

    const { items, nextCursor } = result.value;
    return ctx.json({ invitations: items, nextCursor });
  }

  async function issueInvitation(
    ctx: WorkspaceContext<{ param: WorkspaceParams; json: z.output<typeof ISSUE> }>,
  ) {
    if (!sendEmail) return errorResponse(ctx, 503, 'email_delivery_unavailable');

    const { workspaceId } = ctx.req.valid('param');
    const { email, role } = ctx.req.valid('json');
    const result = await invitations.issue({
      workspaceId,
      email,
      role,
      userId: ctx.get('user').id,
    });
    if (!result.ok) return workspaceError(ctx, result.error);

    const { invitation, token, workspaceName } = result.value;
    const delivery = await sendInvitationEmail(sendEmail, {
      email: invitation.email,
      token,
      workspaceName,
    });
    return ctx.json({ invitation, delivery }, 201);
  }

  async function cancelInvitation(
    ctx: WorkspaceContext<{ param: z.output<typeof INVITATION_ID> }>,
  ) {
    const { workspaceId, invitationId } = ctx.req.valid('param');
    const result = await invitations.cancel({
      workspaceId,
      invitationId,
      userId: ctx.get('user').id,
    });
    return result.ok ? ctx.body(null, 204) : workspaceError(ctx, result.error);
  }

  async function sendInvitationEmail(
    send: SendEmail,
    { email, token, workspaceName }: { email: string; token: string; workspaceName: string },
  ) {
    const link = new URL('/api/workspaces/invitations/review', origin);
    link.searchParams.set('token', token);

    try {
      await send({
        to: email,
        subject: 'Workspace invitation · Always On',
        text: `You have been invited to ${workspaceName}. Sign in with this email to review the invitation.\n\n${link}`,
      });
    } catch (error) {
      reportError(new Error('Workspace invitation email delivery failed', { cause: error }));
      return 'failed';
    }

    return 'sent';
  }
}
