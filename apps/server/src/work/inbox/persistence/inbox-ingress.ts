import { sql } from 'kysely';
import type { DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import type { ChannelEvent, InboxEvent, InboxReceipt } from '../inbox-event.ts';

type IncomingEvent = Omit<ChannelEvent, 'connectionId' | 'sourceEventId'> & {
  source: InboxEvent['source'];
};

const SOURCE_KEY = ['workspace_id', 'source_kind', 'source_id', 'source_event_id'] as const;

export async function appendInboxEvent(
  transaction: DatabaseTransaction,
  event: IncomingEvent,
  traceParent: string | null,
): Promise<InboxReceipt> {
  const { workspaceId, source, eventType, payload, conversationId, replyTo, occurredAt } = event;
  const body = JSON.stringify(payload);
  const receipt = await transaction
    .insertInto('inbox_events')
    .values({
      workspace_id: workspaceId,
      source_kind: source.kind,
      source_id: source.id,
      source_event_id: source.eventId,
      event_type: eventType,
      payload: body,
      conversation_id: conversationId ?? null,
      reply_to: replyTo ?? null,
      occurred_at: occurredAt ?? null,
      trace_parent: traceParent,
    })
    .onConflict((conflict) => conflict.columns(SOURCE_KEY).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (receipt) return { status: 'accepted', eventId: receipt.id, duplicate: false };

  const sameEvent = sql<boolean>`
    event_type = ${eventType}
    AND payload = ${body}::jsonb
    AND conversation_id IS NOT DISTINCT FROM ${conversationId ?? null}::text
    AND reply_to IS NOT DISTINCT FROM ${replyTo ?? null}::text
    AND occurred_at IS NOT DISTINCT FROM ${occurredAt ?? null}::timestamptz(3)
  `;

  // The next READ COMMITTED statement can see a concurrent delivery that won the insert.
  const previous = await transaction
    .selectFrom('inbox_events')
    .select(['id', sameEvent.as('matches')])
    .where('workspace_id', '=', workspaceId)
    .where('source_kind', '=', source.kind)
    .where('source_id', '=', source.id)
    .where('source_event_id', '=', source.eventId)
    .executeTakeFirstOrThrow();
  if (!previous.matches) return { status: 'event_id_conflict' };

  return { status: 'accepted', eventId: previous.id, duplicate: true };
}
