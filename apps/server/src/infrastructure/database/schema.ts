import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** Durable source events; the scope participates in deduplication. */
export const INBOX_EVENTS = pgTable(
  'inbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scopeId: text('scope_id').notNull(),
    source: text('source').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inbox_source_identity').on(table.scopeId, table.source, table.sourceEventId),
  ],
);
