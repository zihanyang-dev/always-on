import { authorizeWorkspaceAccess } from '../../access/index.ts';
import type { Database, DatabaseTransaction } from '../../infrastructure/database/index.ts';
import type { Observability } from '../../infrastructure/index.ts';
import type { InboxEvent, LeaseKey } from '../inbox/inbox-event.ts';
import { MESSAGE_CONTENT } from '../inbox/inbox-message.ts';
import { createInboxObserver } from '../inbox/inbox-observability.ts';
import { lockInboxEvent, settleLockedInboxLease } from '../inbox/persistence/inbox-leases.ts';

type RoutingDecision =
  | { status: 'assigned'; workId: string }
  | { status: 'needs_routing' | 'rejected' };
type RoutingTarget = RoutingDecision | { status: 'new_work'; userId: string; goal: string };

export function createWorkRouter(
  db: Database,
  observability?: Observability,
): (lease: LeaseKey) => Promise<RoutingDecision | null> {
  const observe = createInboxObserver(observability);

  return routeEvent;

  async function routeEvent(lease: LeaseKey) {
    const routed = await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute((tx) => routeInboxEvent(tx, lease));
    if (!routed) return null;

    observe('completed', routed.receipt);
    return routed.decision;
  }
}

async function routeInboxEvent(transaction: DatabaseTransaction, lease: LeaseKey) {
  const event = await lockInboxEvent(transaction, lease);
  if (!event) return null;

  const target = await resolveWork(transaction, event);
  const receipt = await settleLockedInboxLease(transaction, lease, { kind: 'complete' });
  if (!receipt) return null;

  const decision = await createWorkIfRequested(transaction, event.workspaceId, target);
  await recordDecision(transaction, event.id, decision);

  return { receipt, decision };
}

async function resolveWork(
  transaction: DatabaseTransaction,
  event: InboxEvent,
): Promise<RoutingTarget> {
  if (event.source.kind === 'channel') return resolveChannelEvent(transaction, event);

  const { workspaceId, source } = event;
  const access = await authorizeWorkspaceAccess(transaction, {
    workspaceId,
    userId: source.id,
    permission: 'write',
  });
  if (access !== 'allowed') return { status: 'rejected' };

  const { text, target } = MESSAGE_CONTENT.parse(event.payload);
  if (!target) return { status: 'needs_routing' };
  if (target.kind === 'existing_work')
    return lockWork(transaction, { workspaceId, workId: target.workId });

  return { status: 'new_work', userId: source.id, goal: text };
}

async function createWorkIfRequested(
  transaction: DatabaseTransaction,
  workspaceId: string,
  target: RoutingTarget,
): Promise<RoutingDecision> {
  if (target.status !== 'new_work') return target;

  const work = await transaction
    .insertInto('work_items')
    .values({ workspace_id: workspaceId, created_by: target.userId, goal: target.goal })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { status: 'assigned', workId: work.id };
}

async function resolveChannelEvent(
  transaction: DatabaseTransaction,
  event: InboxEvent,
): Promise<RoutingDecision> {
  const { conversationId, source, workspaceId } = event;
  if (!conversationId) return { status: 'needs_routing' };

  const binding = await transaction
    .selectFrom('work_thread_bindings')
    .select('work_id as workId')
    .where('workspace_id', '=', workspaceId)
    .where('connection_id', '=', source.id)
    .where('conversation_id', '=', conversationId)
    .executeTakeFirst();
  if (!binding) return { status: 'needs_routing' };

  return lockWork(transaction, { workspaceId, workId: binding.workId });
}

async function lockWork(
  transaction: DatabaseTransaction,
  { workspaceId, workId }: { workspaceId: string; workId: string },
): Promise<RoutingDecision> {
  // Allocate request order while holding the Work lock.
  const work = await transaction
    .selectFrom('work_items')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', workId)
    .forNoKeyUpdate()
    .executeTakeFirst();

  return work ? { status: 'assigned', workId: work.id } : { status: 'rejected' };
}

async function recordDecision(
  transaction: DatabaseTransaction,
  eventId: string,
  decision: RoutingDecision,
) {
  const workId = decision.status === 'assigned' ? decision.workId : null;
  await transaction
    .insertInto('work_event_decisions')
    .values({ event_id: eventId, disposition: decision.status, work_id: workId })
    .execute();
  if (!workId) return;

  await transaction
    .insertInto('work_run_requests')
    .values({ event_id: eventId, work_id: workId })
    .execute();
}
