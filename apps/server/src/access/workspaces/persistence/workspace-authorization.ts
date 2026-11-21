import type { Database, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import {
  canManageWorkspace,
  failure,
  success,
  type WorkspaceActor,
  type WorkspaceResult,
  type WorkspaceRole,
} from '../workspace.ts';

type LockMode = 'share' | 'update';

/** Permission reads after the Workspace lock must see newly committed membership changes. */
export function workspaceTransaction(db: Database): ReturnType<Database['transaction']> {
  return db.transaction().setIsolationLevel('read committed');
}

export async function readMembershipRole(
  transaction: DatabaseTransaction,
  { workspaceId, userId }: WorkspaceActor,
): Promise<WorkspaceRole | null> {
  const membership = await transaction
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  return membership?.role ?? null;
}

/** Serializes changes that depend on Workspace membership. */
export async function lockWorkspace(
  transaction: DatabaseTransaction,
  { workspaceId, mode }: { workspaceId: string; mode: LockMode },
): Promise<boolean> {
  const query = transaction.selectFrom('workspaces').select('id').where('id', '=', workspaceId);
  const locked = mode === 'share' ? query.forShare() : query.forUpdate();
  return (await locked.executeTakeFirst()) !== undefined;
}

export async function authorizeWorkspace(
  transaction: DatabaseTransaction,
  {
    actor,
    lock,
    access,
  }: {
    actor: WorkspaceActor;
    lock: LockMode;
    access: 'member' | 'manager';
  },
): Promise<WorkspaceResult<WorkspaceRole>> {
  if (!(await lockWorkspace(transaction, { workspaceId: actor.workspaceId, mode: lock })))
    return failure('not_found');

  const role = await readMembershipRole(transaction, actor);
  if (!role) return failure('not_found');
  if (access === 'manager' && !canManageWorkspace(role)) return failure('forbidden');

  return success(role);
}
