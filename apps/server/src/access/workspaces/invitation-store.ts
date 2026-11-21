import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Database, DatabaseTransaction } from '../../infrastructure/database/index.ts';
import { makePage, type Page, type PageRequest } from './page.ts';
import {
  authorizeWorkspace,
  lockWorkspace,
  readMembershipRole,
  workspaceTransaction,
} from './persistence/workspace-authorization.ts';
import {
  failure,
  type InvitationRole,
  success,
  type WorkspaceActor,
  type WorkspaceInvitation,
  type WorkspaceResult,
} from './workspace.ts';

const INVITATION_COLUMNS = [
  'workspace_invitations.id',
  'workspace_invitations.workspace_id as workspaceId',
  'workspace_invitations.email',
  'workspace_invitations.role',
  'workspace_invitations.created_at as createdAt',
  'workspace_invitations.expires_at as expiresAt',
] as const;
const DATABASE_NOW = sql<Date>`clock_timestamp()`;

type IssueInvitation = WorkspaceActor & { email: string; role: InvitationRole };
type IssuedInvitation = { invitation: WorkspaceInvitation; workspaceName: string; token: string };
type CancelInvitation = WorkspaceActor & { invitationId: string };
type InvitationProof = { token: string; email: string };
type Recipient = InvitationProof & { userId: string };
type ReviewedInvitation = WorkspaceInvitation & { workspaceName: string };
type AcceptedInvitation = { workspaceId: string; role: InvitationRole };

export type InvitationStore = {
  issue: (input: IssueInvitation) => Promise<WorkspaceResult<IssuedInvitation>>;
  list: (
    input: WorkspaceActor & { page: PageRequest },
  ) => Promise<WorkspaceResult<Page<WorkspaceInvitation>>>;
  cancel: (input: CancelInvitation) => Promise<WorkspaceResult<void>>;
  review: (proof: InvitationProof) => Promise<WorkspaceResult<ReviewedInvitation>>;
  accept: (recipient: Recipient) => Promise<WorkspaceResult<AcceptedInvitation>>;
  reject: (recipient: Recipient) => Promise<WorkspaceResult<void>>;
};

export function createInvitationStore(db: Database): InvitationStore {
  return { issue, list, cancel, review, accept, reject };

  function issue({ workspaceId, userId, email, role }: IssueInvitation) {
    return workspaceTransaction(db).execute(async (transaction) => {
      const access = await authorizeWorkspace(transaction, {
        actor: { workspaceId, userId },
        lock: 'update',
        access: 'manager',
      });
      if (!access.ok) return access;

      const member = await transaction
        .selectFrom('workspace_members')
        .innerJoin('users', 'users.id', 'workspace_members.user_id')
        .select('users.id')
        .where('workspace_members.workspace_id', '=', workspaceId)
        .where('users.email', '=', email)
        .executeTakeFirst();
      if (member) return failure('already_member');

      await transaction
        .updateTable('workspace_invitations')
        .set({ status: 'cancelled' })
        .where('workspace_id', '=', workspaceId)
        .where('email', '=', email)
        .where('status', '=', 'pending')
        .execute();

      const workspace = await transaction
        .selectFrom('workspaces')
        .select('name')
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow();
      const token = randomBytes(32).toString('base64url');
      const invitation = await transaction
        .insertInto('workspace_invitations')
        .values({
          workspace_id: workspaceId,
          email,
          role,
          token_hash: hashToken(token),
          expires_at: sql<Date>`clock_timestamp() + interval '7 days'`,
          created_by: userId,
        })
        .returning(INVITATION_COLUMNS)
        .executeTakeFirstOrThrow();

      return success({ workspaceName: workspace.name, invitation, token });
    });
  }

  function list({ workspaceId, userId, page }: WorkspaceActor & { page: PageRequest }) {
    return workspaceTransaction(db).execute(async (transaction) => {
      const access = await authorizeWorkspace(transaction, {
        actor: { workspaceId, userId },
        lock: 'share',
        access: 'manager',
      });
      if (!access.ok) return access;

      const { cursor, limit } = page;
      let query = transaction
        .selectFrom('workspace_invitations')
        .select(INVITATION_COLUMNS)
        .where('workspace_id', '=', workspaceId)
        .where('status', '=', 'pending')
        .where('expires_at', '>', DATABASE_NOW);
      if (cursor) {
        query = query.where(
          sql<boolean>`(created_at, id) > (${cursor.time}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const rows = await query
        .orderBy('created_at')
        .orderBy('id')
        .limit(limit + 1)
        .execute();
      return success(makePage(rows, limit, (row) => ({ time: row.createdAt, id: row.id })));
    });
  }

  function cancel({ workspaceId, userId, invitationId }: CancelInvitation) {
    return workspaceTransaction(db).execute(async (transaction) => {
      const access = await authorizeWorkspace(transaction, {
        actor: { workspaceId, userId },
        lock: 'update',
        access: 'manager',
      });
      if (!access.ok) return access;

      const cancelled = await transaction
        .updateTable('workspace_invitations')
        .set({ status: 'cancelled' })
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', invitationId)
        .where('status', '=', 'pending')
        .where('expires_at', '>', DATABASE_NOW)
        .returning('id')
        .executeTakeFirst();

      return cancelled ? success(undefined) : failure('not_found');
    });
  }

  async function review({ email, token }: InvitationProof) {
    const invitation = await db
      .selectFrom('workspace_invitations')
      .innerJoin('workspaces', 'workspaces.id', 'workspace_invitations.workspace_id')
      .select([...INVITATION_COLUMNS, 'workspaces.name as workspaceName'])
      .where('workspace_invitations.token_hash', '=', hashToken(token))
      .where('workspace_invitations.email', '=', email.toLowerCase())
      .where('workspace_invitations.status', '=', 'pending')
      .where('workspace_invitations.expires_at', '>', DATABASE_NOW)
      .executeTakeFirst();

    return invitation ? success(invitation) : failure('not_found');
  }

  function accept(recipient: Recipient) {
    return workspaceTransaction(db).execute(async (transaction) => {
      const pending = await lockPendingInvitation(transaction, recipient);
      if (!pending.ok) return pending;

      const { id, workspaceId, role } = pending.value;
      const userId = recipient.userId;
      if (await readMembershipRole(transaction, { workspaceId, userId }))
        return failure('already_member');

      if (!(await answerInvitation(transaction, { id, status: 'accepted' })))
        return failure('invitation_used');

      await transaction
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceId, user_id: userId, role })
        .execute();

      return success({ workspaceId, role });
    });
  }

  function reject(recipient: Recipient) {
    return workspaceTransaction(db).execute(async (transaction) => {
      const pending = await lockPendingInvitation(transaction, recipient);
      if (!pending.ok) return pending;

      const rejected = await answerInvitation(transaction, {
        id: pending.value.id,
        status: 'rejected',
      });
      return rejected ? success(undefined) : failure('invitation_used');
    });
  }
}

async function lockPendingInvitation(
  transaction: DatabaseTransaction,
  { email, token }: InvitationProof,
): Promise<WorkspaceResult<AcceptedInvitation & { id: string }>> {
  const candidate = await transaction
    .selectFrom('workspace_invitations')
    .select(['id', 'workspace_id as workspaceId'])
    .where('token_hash', '=', hashToken(token))
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
  if (!candidate) return failure('not_found');
  if (!(await lockWorkspace(transaction, { workspaceId: candidate.workspaceId, mode: 'update' })))
    return failure('not_found');

  const pending = await transaction
    .selectFrom('workspace_invitations')
    .select(['id', 'workspace_id as workspaceId', 'role'])
    .where('id', '=', candidate.id)
    .where('status', '=', 'pending')
    .where('expires_at', '>', DATABASE_NOW)
    .executeTakeFirst();

  return pending ? success(pending) : failure('invitation_used');
}

async function answerInvitation(
  transaction: DatabaseTransaction,
  { id, status }: { id: string; status: 'accepted' | 'rejected' },
): Promise<boolean> {
  const invitation = await transaction
    .updateTable('workspace_invitations')
    .set({ status })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .where('expires_at', '>', DATABASE_NOW)
    .returning('id')
    .executeTakeFirst();

  return invitation !== undefined;
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
