import { z } from 'zod';
import { type Database, INBOX_EVENTS } from '../infrastructure/database/index.js';

const INBOX_INPUT_SCHEMA = z.object({
  source: z.string().min(1).max(100),
  sourceEventId: z.string().min(1).max(500),
  payload: z.json(),
});

/** The outcome of accepting a source event without dispatching execution yet. */
export type InboxAcceptance =
  | { status: 'accepted'; id: string }
  | { status: 'duplicate' }
  | { status: 'invalid'; fields: readonly string[] };

/** Validates and atomically deduplicates events within a trusted caller-provided scope. */
export async function appendInboxEvent({
  db,
  scopeId,
  event,
}: {
  db: Database;
  scopeId: string;
  event: unknown;
}): Promise<InboxAcceptance> {
  const result = INBOX_INPUT_SCHEMA.safeParse(event);
  if (!result.success)
    return {
      status: 'invalid',
      fields: result.error.issues.map((issue) => issue.path.join('.')),
    };

  // Only a repeated source identity is a duplicate; unrelated constraint failures must surface.
  const [inserted] = await db
    .insert(INBOX_EVENTS)
    .values({ ...result.data, scopeId })
    .onConflictDoNothing({
      target: [INBOX_EVENTS.scopeId, INBOX_EVENTS.source, INBOX_EVENTS.sourceEventId],
    })
    .returning({ id: INBOX_EVENTS.id });
  if (!inserted) return { status: 'duplicate' };

  return { status: 'accepted', id: inserted.id };
}
