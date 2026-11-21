import { sql } from 'kysely';
import { authorizeWorkspaceAccess } from '../../access/index.ts';
import type { Database, DatabaseTransaction } from '../../infrastructure/database/index.ts';
import type { WorkItem, WorkLocation, WorkspaceUser, WorkThread } from './work-item.ts';

type AccessError = 'not_found' | 'forbidden';
type ReadResult<T> = { status: 'found'; value: T } | { status: AccessError };
type MessageRouting = {
  status: 'pending' | 'assigned' | 'needs_routing' | 'rejected';
  workId: string | null;
};

const PENDING_RUN_STATUS = sql<'running' | 'queued'>`
  CASE
    WHEN lease_token IS NOT NULL AND available_at > statement_timestamp() THEN 'running'
    ELSE 'queued'
  END
`.as('status');

export type WorkStore = {
  read: (input: WorkLocation & WorkspaceUser) => Promise<ReadResult<WorkItem>>;
  messageRouting: (
    input: WorkspaceUser & { eventId: string },
  ) => Promise<ReadResult<MessageRouting>>;
  bindThread: (
    input: WorkLocation & WorkspaceUser & WorkThread,
  ) => Promise<'bound' | 'thread_already_bound' | AccessError>;
};

export function createWorkStore(db: Database): WorkStore {
  const transaction = () => db.transaction().setIsolationLevel('read committed');

  return {
    read: (input) => transaction().execute((tx) => readWork(tx, input)),
    messageRouting: (input) => transaction().execute((tx) => messageRouting(tx, input)),
    bindThread: (input) => transaction().execute((tx) => bindThread(tx, input)),
  };
}

async function readWork(
  tx: DatabaseTransaction,
  { workspaceId, workId, userId }: WorkLocation & WorkspaceUser,
): Promise<ReadResult<WorkItem>> {
  const access = await authorizeWorkspaceAccess(tx, { workspaceId, userId, permission: 'read' });
  if (access !== 'allowed') return { status: access };

  const work = await tx
    .selectFrom('work_items as work')
    .select([
      'id as workId',
      'workspace_id as workspaceId',
      'goal',
      'progress',
      'created_at as createdAt',
    ])
    .select((query) =>
      query
        .selectFrom('work_run_requests as request')
        .select(PENDING_RUN_STATUS)
        .whereRef('request.work_id', '=', 'work.id')
        .where('request.completed_at', 'is', null)
        .orderBy('request.sequence')
        .limit(1)
        .as('pendingStatus'),
    )
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', workId)
    .executeTakeFirst();
  if (!work) return { status: 'not_found' };

  const { pendingStatus, ...details } = work;
  return { status: 'found', value: { ...details, status: pendingStatus ?? 'waiting' } };
}

async function messageRouting(
  tx: DatabaseTransaction,
  { workspaceId, userId, eventId }: WorkspaceUser & { eventId: string },
): Promise<ReadResult<MessageRouting>> {
  const access = await authorizeWorkspaceAccess(tx, { workspaceId, userId, permission: 'read' });
  if (access !== 'allowed') return { status: access };

  const routing = await tx
    .selectFrom('inbox_events as event')
    .leftJoin('work_event_decisions as decision', 'decision.event_id', 'event.id')
    .select(['decision.disposition', 'decision.work_id as workId'])
    .where('event.id', '=', eventId)
    .where('event.workspace_id', '=', workspaceId)
    .where('event.source_kind', '=', 'user')
    .where('event.source_id', '=', userId)
    .executeTakeFirst();
  if (!routing) return { status: 'not_found' };

  return {
    status: 'found',
    value: { status: routing.disposition ?? 'pending', workId: routing.workId },
  };
}

async function bindThread(
  tx: DatabaseTransaction,
  {
    workspaceId,
    userId,
    workId,
    connectionId,
    conversationId,
  }: WorkLocation & WorkspaceUser & WorkThread,
): Promise<'bound' | 'thread_already_bound' | AccessError> {
  const access = await authorizeWorkspaceAccess(tx, { workspaceId, userId, permission: 'write' });
  if (access !== 'allowed') return access;

  const work = await tx
    .selectFrom('work_items')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', workId)
    .executeTakeFirst();
  if (!work) return 'not_found';

  const binding = {
    workspace_id: workspaceId,
    work_id: workId,
    connection_id: connectionId,
    conversation_id: conversationId,
  };
  const inserted = await tx
    .insertInto('work_thread_bindings')
    .values(binding)
    .onConflict((conflict) =>
      conflict.columns(['workspace_id', 'connection_id', 'conversation_id']).doNothing(),
    )
    .returning('work_id')
    .executeTakeFirst();
  if (inserted) return 'bound';

  const existing = await tx
    .selectFrom('work_thread_bindings')
    .select('work_id')
    .where('workspace_id', '=', workspaceId)
    .where('connection_id', '=', connectionId)
    .where('conversation_id', '=', conversationId)
    .executeTakeFirstOrThrow();

  return existing.work_id === workId ? 'bound' : 'thread_already_bound';
}
