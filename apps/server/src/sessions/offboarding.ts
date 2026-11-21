import { and, eq, ne } from 'drizzle-orm';
import { deleteEmptyPrivateAgents } from '../agents/index.js';
import {
  AGENT_SESSIONS,
  type Database,
  type DatabaseTransaction,
} from '../infrastructure/database/index.js';
import { hasAgentPermission, lockWorkspace, readWorkspaceRoles } from '../workspaces/index.js';
import { hasNoBlockingRuns, startSessionDeletion } from './deletion.js';

const OFFBOARDING_BATCH_SIZE = 100;

type OffboardingResult =
  | {
      readonly status: 'accepted';
      readonly scheduledSessions: number;
      readonly remainingSessions: number;
      readonly deletedPrivateAgents: number;
    }
  | { readonly status: 'not_found' | 'still_a_member' };

/** Schedules cleanup for a former member without allowing administrators to read private data. */
export async function cleanFormerMemberResources({
  db,
  actorId,
  workspaceId,
  userId,
}: {
  db: Database;
  actorId: string;
  workspaceId: string;
  userId: string;
}): Promise<OffboardingResult> {
  return db.transaction(clean);

  async function clean(transaction: DatabaseTransaction): Promise<OffboardingResult> {
    // Membership mutations and invitation acceptance take the conflicting Workspace lock.
    if (!(await lockWorkspace(transaction, workspaceId))) return { status: 'not_found' };
    const roles = await readWorkspaceRoles({ transaction, workspaceId, userId: actorId });
    if (!roles || !hasAgentPermission({ roles, action: 'manage' })) return { status: 'not_found' };
    if (await readWorkspaceRoles({ transaction, workspaceId, userId }))
      return { status: 'still_a_member' };

    const owned = and(
      eq(AGENT_SESSIONS.workspaceId, workspaceId),
      eq(AGENT_SESSIONS.createdBy, userId),
      ne(AGENT_SESSIONS.status, 'deleting'),
    );
    const total = await transaction.$count(AGENT_SESSIONS, owned);
    const sessions = await transaction
      .select({ id: AGENT_SESSIONS.id })
      .from(AGENT_SESSIONS)
      .where(and(owned, hasNoBlockingRuns(transaction)))
      .orderBy(AGENT_SESSIONS.id)
      .limit(OFFBOARDING_BATCH_SIZE)
      .for('update', { skipLocked: true });
    const scheduled = await startSessionDeletion(
      transaction,
      sessions.map(({ id }) => id),
    );
    const deletedPrivateAgents = await deleteEmptyPrivateAgents({
      transaction,
      workspaceId,
      userId,
    });

    return {
      status: 'accepted',
      scheduledSessions: scheduled.length,
      remainingSessions: total - scheduled.length,
      deletedPrivateAgents,
    };
  }
}
