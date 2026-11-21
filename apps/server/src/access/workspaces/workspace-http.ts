import type { Context, Next } from 'hono';
import { z } from 'zod';
import { errorResponse } from '../../http/index.ts';
import type { SignedInUser } from '../authentication/index.ts';
import type { WorkspaceError } from './workspace.ts';

export type WorkspaceEnv = { Variables: { user: SignedInUser } };
export type WorkspaceContext<T extends object> = Context<WorkspaceEnv, string, { out: T }>;

const MEMBER_USER_ID = z.string().min(1).max(128).refine(withoutNullByte);
export const WORKSPACE_ID = z.object({ workspaceId: z.uuid() });
export const MEMBER_ID = WORKSPACE_ID.extend({ memberUserId: MEMBER_USER_ID });
export const WORKSPACE_NAME = z.object({
  name: z.string().trim().min(1).max(100).refine(withoutNullByte),
});
export const WORKSPACE_PAGE_QUERY = pageQuery(z.uuid());
export const MEMBER_PAGE_QUERY = pageQuery(MEMBER_USER_ID);
export type WorkspaceParams = z.output<typeof WORKSPACE_ID>;

const STATUS = {
  not_found: 404,
  forbidden: 403,
  last_owner: 409,
  already_member: 409,
  invitation_used: 409,
} as const satisfies Record<WorkspaceError, number>;

export function workspaceError(ctx: Context, error: WorkspaceError): Response {
  return errorResponse(ctx, STATUS[error], error);
}

export async function requireVerifiedEmail(
  ctx: Context<WorkspaceEnv>,
  next: Next,
): Promise<Response | undefined> {
  if (!ctx.get('user').emailVerified) return errorResponse(ctx, 403, 'email_verification_required');

  await next();
}

function pageQuery(id: z.ZodType<string>) {
  const cursor = z.object({
    time: z.iso.datetime({ precision: 3 }).refine((time) => !time.startsWith('0000-')),
    id,
  });

  return z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z
      .base64url()
      .max(1100)
      .transform((value, ctx) => {
        const parsed = cursor.safeParse(decodeCursor(value));
        if (parsed.success) return parsed.data;
        ctx.addIssue({ code: 'custom', message: 'Invalid page cursor' });
        return z.NEVER;
      })
      .optional(),
  });
}

function decodeCursor(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function withoutNullByte(value: string) {
  return !value.includes('\u0000');
}
