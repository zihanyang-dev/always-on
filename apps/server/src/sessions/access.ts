import type { AgentSession } from '@always-on/contracts/agents';
import { and, eq } from 'drizzle-orm';
import { readUsableAgent } from '../agents/index.js';
import {
  AGENT_SESSIONS,
  type Database,
  type DatabaseTransaction,
  WORKSPACE_MEMBERS,
} from '../infrastructure/database/index.js';
import { hasAgentPermission } from '../workspaces/index.js';
import { parseSession } from './records.js';

/** Identity required to read or mutate one private conversation. */
export type SessionAccess = { db: Database; sessionId: string; userId: string };

/** Locks a private Session and checks current membership before returning its public settings. */
export async function readSessionAccess({
  transaction,
  sessionId,
  userId,
  action,
}: {
  transaction: DatabaseTransaction;
  sessionId: string;
  userId: string;
  action: 'read' | 'use' | 'manage';
}): Promise<AgentSession | null> {
  const session = await readOwnedSession({
    transaction,
    sessionId,
    userId,
    action: action === 'read' ? 'read' : 'manage',
  });
  if (!session || session.status === 'deleting') return null;

  // Organization and cancellation remain available even when the Agent has been disabled.
  if (action === 'use') {
    const agent = await readUsableAgent({ transaction, agentId: session.agentId, userId });
    if (!agent) return null;
  }

  return parseSession(session);
}

/** Locks the owned row, retaining private cleanup facts for the deletion lifecycle. */
export async function readOwnedSession({
  transaction,
  sessionId,
  userId,
  action,
}: {
  transaction: DatabaseTransaction;
  sessionId: string;
  userId: string;
  action: 'read' | 'manage';
}): Promise<typeof AGENT_SESSIONS.$inferSelect | null> {
  // Workspace membership never grants access to somebody else's private conversation.
  const [session] = await transaction
    .select()
    .from(AGENT_SESSIONS)
    .where(and(eq(AGENT_SESSIONS.id, sessionId), eq(AGENT_SESSIONS.createdBy, userId)))
    .for(action === 'read' ? 'share' : 'update');
  if (!session) return null;

  const hasAccess = await hasWorkspaceSessionAccess({
    transaction,
    workspaceId: session.workspaceId,
    userId,
    action: action === 'read' ? 'read' : 'use',
  });
  if (!hasAccess) return null;

  return session;
}

/** Holds current membership through the transaction that reads or admits Session work. */
export async function hasWorkspaceSessionAccess({
  transaction,
  workspaceId,
  userId,
  action,
}: {
  transaction: DatabaseTransaction;
  workspaceId: string;
  userId: string;
  action: 'read' | 'use';
}): Promise<boolean> {
  // Removal waits for this short transaction, never for a model request or an SSE subscription.
  const [membership] = await transaction
    .select({ roles: WORKSPACE_MEMBERS.role })
    .from(WORKSPACE_MEMBERS)
    .where(
      and(eq(WORKSPACE_MEMBERS.organizationId, workspaceId), eq(WORKSPACE_MEMBERS.userId, userId)),
    )
    .for('share');

  return membership !== undefined && hasAgentPermission({ roles: membership.roles, action });
}
