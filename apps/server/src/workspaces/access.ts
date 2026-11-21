import { and, eq } from 'drizzle-orm';
import {
  type DatabaseTransaction,
  WORKSPACE_MEMBERS,
  WORKSPACE_TABLES,
} from '../infrastructure/database/index.js';

/** Shares the Workspace row lock with operations that admit or remove its resources. */
export async function lockWorkspace(
  transaction: DatabaseTransaction,
  workspaceId: string,
): Promise<boolean> {
  const [workspace] = await transaction
    .select({ id: WORKSPACE_TABLES.organization.id })
    .from(WORKSPACE_TABLES.organization)
    .where(eq(WORKSPACE_TABLES.organization.id, workspaceId))
    .for('share');

  return workspace !== undefined;
}

/** Holds current membership until the resource access transaction finishes. */
export async function readWorkspaceRoles({
  transaction,
  workspaceId,
  userId,
}: {
  transaction: DatabaseTransaction;
  workspaceId: string;
  userId: string;
}): Promise<string | undefined> {
  const [membership] = await transaction
    .select({ roles: WORKSPACE_MEMBERS.role })
    .from(WORKSPACE_MEMBERS)
    .where(
      and(eq(WORKSPACE_MEMBERS.organizationId, workspaceId), eq(WORKSPACE_MEMBERS.userId, userId)),
    )
    .for('share');

  return membership?.roles;
}
