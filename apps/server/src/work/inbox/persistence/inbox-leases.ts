import { type Selectable, sql } from 'kysely';
import {
  DATABASE_SCHEMA,
  type DatabaseSchema,
  type DatabaseTransaction,
} from '../../../infrastructure/database/index.ts';
import type { InboxLease, LeaseKey } from '../inbox-event.ts';

type InboxRow = Selectable<DatabaseSchema['inbox_events']>;
type LeaseOutcome = { kind: 'complete' } | { kind: 'retry'; delayMs: number };
type SettledEvent = { id: string; source: 'user' | 'channel'; traceParent: string | null };

const EVENTS = sql.table(`${DATABASE_SCHEMA}.inbox_events`);
const NOW = sql<Date>`clock_timestamp()`;

export async function claimInboxEvents(
  transaction: DatabaseTransaction,
  { limit, leaseMs }: { limit: number; leaseMs: number },
): Promise<InboxLease[]> {
  const claimed = await sql<InboxRow>`
    WITH claimable AS MATERIALIZED (
      SELECT id
      FROM ${EVENTS}
      WHERE completed_at IS NULL AND available_at <= statement_timestamp()
      ORDER BY available_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${EVENTS} AS inbox
    SET available_at = ${afterMilliseconds(leaseMs)},
        lease_token = gen_random_uuid(),
        attempt_count = inbox.attempt_count + 1
    FROM claimable
    WHERE inbox.id = claimable.id
    RETURNING inbox.*
  `.execute(transaction);

  return claimed.rows.map(toLease);
}

export async function settleInboxLease(
  transaction: DatabaseTransaction,
  { eventId, token }: LeaseKey,
  outcome: LeaseOutcome,
): Promise<SettledEvent | null> {
  const lease = await transaction
    .selectFrom('inbox_events')
    .select('id')
    .where('id', '=', eventId)
    .where('lease_token', '=', token)
    .forUpdate()
    .executeTakeFirst();
  if (!lease) return null;

  const change =
    outcome.kind === 'complete'
      ? { lease_token: null, completed_at: NOW }
      : { lease_token: null, available_at: afterMilliseconds(outcome.delayMs) };

  // Check the time after locking so a waiting acknowledgement cannot use an expired lease.
  const saved = await transaction
    .updateTable('inbox_events')
    .set(change)
    .where('id', '=', lease.id)
    .where('available_at', '>', NOW)
    .returning(['id', 'source_kind as source', 'trace_parent as traceParent'])
    .executeTakeFirst();

  return saved ?? null;
}

function toLease(row: InboxRow): InboxLease {
  const payload = row.payload;
  if (!row.lease_token) throw new Error('Claimed Inbox event is missing its lease token');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('Stored Inbox payload must be an object');

  return {
    token: row.lease_token,
    expiresAt: row.available_at,
    attempt: row.attempt_count,
    event: {
      id: row.id,
      workspaceId: row.workspace_id,
      source: { kind: row.source_kind, id: row.source_id, eventId: row.source_event_id },
      eventType: row.event_type,
      payload,
      conversationId: row.conversation_id,
      replyTo: row.reply_to,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
      traceParent: row.trace_parent,
    },
  };
}

function afterMilliseconds(ms: number) {
  return sql<Date>`clock_timestamp() + make_interval(secs => ${ms / 1000})`;
}
