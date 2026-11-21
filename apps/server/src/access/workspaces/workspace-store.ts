import { sql } from 'kysely';
import type { Database, DatabaseTransaction } from '../../infrastructure/database/index.ts';
import { makePage, type Page, type PageRequest } from './page.ts';
import {
  authorizeWorkspace,
  readMembershipRole,
  workspaceTransaction,
} from './persistence/workspace-authorization.ts';
import {
  canChangeMembership,
  failure,
  success,
  type Workspace,
  type WorkspaceActor,
  type WorkspaceMember,
  type WorkspaceResult,
  type WorkspaceRole,
} from './workspace.ts';

type CreateWorkspace = { name: string; userId: string };
type MembershipTarget = WorkspaceActor & { memberUserId: string };
type RoleChange = MembershipTarget & { nextRole: WorkspaceRole };

export type WorkspaceStore = {
  create: (input: CreateWorkspace) => Promise<Workspace>;
  list: (input: { userId: string; page: PageRequest }) => Promise<Page<Workspace>>;
  get: (actor: WorkspaceActor) => Promise<Workspace | null>;
  rename: (input: WorkspaceActor & { name: string }) => Promise<WorkspaceResult<Workspace>>;
  listMembers: (
    input: WorkspaceActor & { page: PageRequest },
  ) => Promise<WorkspaceResult<Page<WorkspaceMember>>>;
  changeMemberRole: (input: RoleChange) => Promise<WorkspaceResult<void>>;
  removeMember: (input: MembershipTarget) => Promise<WorkspaceResult<void>>;
  leave: (actor: WorkspaceActor) => Promise<WorkspaceResult<void>>;
};

export function createWorkspaceStore(db: Database): WorkspaceStore {
  return {
    create,
    list,
    get,
    rename,
    listMembers,
    changeMemberRole: updateMember,
    removeMember: (input) => updateMember({ ...input, nextRole: null }),
    leave,
  };

  function create({ name, userId }: CreateWorkspace): Promise<Workspace> {
    return workspaceTransaction(db).execute(async (transaction) => {
      const workspace = await transaction
        .insertInto('workspaces')
        .values({ name })
        .returning(['id', 'name', 'created_at as createdAt'])
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto('workspace_members')
        .values({ workspace_id: workspace.id, user_id: userId, role: 'owner' })
        .execute();

      return { ...workspace, role: 'owner' };
    });
  }

  async function list({ userId, page }: { userId: string; page: PageRequest }) {
    const { cursor, limit } = page;
    let query = selectWorkspaces(userId);
    if (cursor) {
      query = query.where(
        ({ ref }) =>
          sql<boolean>`(${ref('w.created_at')}, ${ref('w.id')}) > (${cursor.time}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const rows = await query
      .orderBy('w.created_at')
      .orderBy('w.id')
      .limit(limit + 1)
      .execute();
    return makePage(rows, limit, (row) => ({ time: row.createdAt, id: row.id }));
  }

  async function get({ workspaceId, userId }: WorkspaceActor) {
    const workspace = await selectWorkspaces(userId)
      .where('w.id', '=', workspaceId)
      .executeTakeFirst();
    return workspace ?? null;
  }

  function selectWorkspaces(userId: string) {
    return db
      .selectFrom('workspace_members as m')
      .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
      .select(['w.id', 'w.name', 'w.created_at as createdAt', 'm.role'])
      .where('m.user_id', '=', userId);
  }

  function rename({ workspaceId, userId, name }: WorkspaceActor & { name: string }) {
    return workspaceTransaction(db).execute(async (transaction) => {
      const access = await authorizeWorkspace(transaction, {
        actor: { workspaceId, userId },
        lock: 'update',
        access: 'manager',
      });
      if (!access.ok) return access;

      const workspace = await transaction
        .updateTable('workspaces')
        .set({ name })
        .where('id', '=', workspaceId)
        .returning(['id', 'name', 'created_at as createdAt'])
        .executeTakeFirstOrThrow();

      return success({ ...workspace, role: access.value });
    });
  }

  function listMembers({ workspaceId, userId, page }: WorkspaceActor & { page: PageRequest }) {
    return workspaceTransaction(db).execute(async (transaction) => {
      const access = await authorizeWorkspace(transaction, {
        actor: { workspaceId, userId },
        lock: 'share',
        access: 'member',
      });
      if (!access.ok) return access;

      const { cursor, limit } = page;
      let query = transaction
        .selectFrom('workspace_members as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['m.user_id as userId', 'u.name', 'u.image', 'm.role', 'm.joined_at as joinedAt'])
        .where('m.workspace_id', '=', workspaceId);
      if (cursor) {
        query = query.where(
          ({ ref }) =>
            sql<boolean>`(${ref('m.joined_at')}, ${ref('m.user_id')}) > (${cursor.time}::timestamptz, ${cursor.id}::text)`,
        );
      }

      const rows = await query
        .orderBy('m.joined_at')
        .orderBy('m.user_id')
        .limit(limit + 1)
        .execute();
      return success(makePage(rows, limit, (row) => ({ time: row.joinedAt, id: row.userId })));
    });
  }

  function updateMember({
    workspaceId,
    userId,
    memberUserId,
    nextRole,
  }: MembershipTarget & { nextRole: WorkspaceRole | null }) {
    return workspaceTransaction(db).execute(async (transaction) => {
      const access = await authorizeWorkspace(transaction, {
        actor: { workspaceId, userId },
        lock: 'update',
        access: 'manager',
      });
      if (!access.ok) return access;

      const member = { workspaceId, userId: memberUserId };
      const currentRole = await readMembershipRole(transaction, member);
      if (!currentRole) return failure('not_found');
      if (!canChangeMembership({ actorRole: access.value, currentRole, nextRole }))
        return failure('forbidden');

      return writeMembership(transaction, { member, currentRole, nextRole });
    });
  }

  function leave(actor: WorkspaceActor) {
    return workspaceTransaction(db).execute(async (transaction) => {
      const access = await authorizeWorkspace(transaction, {
        actor,
        lock: 'update',
        access: 'member',
      });
      if (!access.ok) return access;

      return writeMembership(transaction, {
        member: actor,
        currentRole: access.value,
        nextRole: null,
      });
    });
  }
}

async function writeMembership(
  transaction: DatabaseTransaction,
  {
    member,
    currentRole,
    nextRole,
  }: {
    member: WorkspaceActor;
    currentRole: WorkspaceRole;
    nextRole: WorkspaceRole | null;
  },
): Promise<WorkspaceResult<void>> {
  if (currentRole === nextRole) return success(undefined);

  if (currentRole === 'owner') {
    const owners = await transaction
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', member.workspaceId)
      .where('role', '=', 'owner')
      .limit(2)
      .execute();

    if (owners.length < 2) return failure('last_owner');
  }

  const { workspaceId, userId } = member;
  if (nextRole) {
    await transaction
      .updateTable('workspace_members')
      .set({ role: nextRole })
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .execute();
  } else {
    await transaction
      .deleteFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .execute();
  }

  return success(undefined);
}
