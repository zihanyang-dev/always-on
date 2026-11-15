import { and, eq } from 'drizzle-orm';
import {
  type Database,
  WORKSPACE_MEMBERS,
  WORKSPACE_TABLES,
} from '../infrastructure/database/index.js';
import { hasAgentPermission } from './permissions.js';

/** Reads human workspace context through current membership, without exposing authentication data. */
export async function readWorkspaceSummary({
  db,
  workspaceId,
  userId,
}: {
  db: Database;
  workspaceId: string;
  userId: string;
}): Promise<{ id: string; name: string } | null> {
  const [workspace] = await db
    .select({
      id: WORKSPACE_TABLES.organization.id,
      name: WORKSPACE_TABLES.organization.name,
      roles: WORKSPACE_MEMBERS.role,
    })
    .from(WORKSPACE_TABLES.organization)
    .innerJoin(
      WORKSPACE_MEMBERS,
      eq(WORKSPACE_MEMBERS.organizationId, WORKSPACE_TABLES.organization.id),
    )
    .where(
      and(eq(WORKSPACE_TABLES.organization.id, workspaceId), eq(WORKSPACE_MEMBERS.userId, userId)),
    );
  if (!workspace || !hasAgentPermission({ roles: workspace.roles, action: 'use' })) return null;
  return { id: workspace.id, name: workspace.name };
}
