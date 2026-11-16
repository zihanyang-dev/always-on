import { SESSION_DELETION_SCHEMA, type SessionDeletion } from '@always-on/contracts/agents';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  AGENT_RUNS,
  AGENT_SESSIONS,
  type Database,
  type DatabaseTransaction,
  INBOX_EVENTS,
} from '../infrastructure/database/index.js';
import { readOwnedSession, type SessionAccess } from './access.js';

const CLEANUP_ATTEMPT_TIMEOUT_SECONDS = 60;
const MAX_CLEANUP_RETRY_SECONDS = 300;

/** Cloud resource identities retained by the immutable deletion request. */
export type SessionResources = { readonly sessionId: string; readonly sandboxId: string | null };

/** Releases only the resource identities supplied by the durable Session owner. */
export type DeleteSessionResources = (resources: SessionResources) => Promise<void>;

/** A durable request or an expected authorization/execution-state rejection. */
export type SessionDeletionResult =
  | { readonly status: 'accepted'; readonly deletion: SessionDeletion }
  | { readonly status: 'not_found' | 'busy' | 'recovery_required' };

/** Accepts deletion only after all admitted execution has reached a known terminal boundary. */
export async function requestSessionDeletion({
  db,
  sessionId,
  userId,
}: SessionAccess): Promise<SessionDeletionResult> {
  return db.transaction(request);

  async function request(transaction: DatabaseTransaction): Promise<SessionDeletionResult> {
    const session = await readOwnedSession({ transaction, sessionId, userId, action: 'manage' });
    if (!session) return { status: 'not_found' };
    if (session.status === 'deleting')
      return { status: 'accepted', deletion: parseDeletion(session) };

    // Retain unknown-effect evidence. Neither cancellation nor a delete request reconciles it.
    const [blocker] = await transaction
      .select({ status: AGENT_RUNS.status })
      .from(AGENT_RUNS)
      .where(
        and(
          eq(AGENT_RUNS.sessionId, sessionId),
          inArray(AGENT_RUNS.status, ['queued', 'running', 'cancelling', 'recovery_required']),
        ),
      )
      .orderBy(desc(sql`${AGENT_RUNS.status} = 'recovery_required'`))
      .limit(1);
    if (blocker)
      return { status: blocker.status === 'recovery_required' ? 'recovery_required' : 'busy' };

    const [requested] = await transaction
      .update(AGENT_SESSIONS)
      .set({
        status: 'deleting',
        deletionRequestedAt: sql`clock_timestamp()`,
        cleanupAfter: sql`clock_timestamp()`,
        revision: sql`${AGENT_SESSIONS.revision} + 1`,
      })
      .where(eq(AGENT_SESSIONS.id, sessionId))
      .returning();
    if (!requested) throw new Error(`Session ${sessionId} disappeared during deletion request`);

    return { status: 'accepted', deletion: parseDeletion(requested) };
  }
}

/** Reads cleanup progress only while the original owner retains Workspace read permission. */
export async function readSessionDeletion({
  db,
  sessionId,
  userId,
}: SessionAccess): Promise<SessionDeletion | null> {
  return db.transaction(read);

  async function read(transaction: DatabaseTransaction) {
    const session = await readOwnedSession({ transaction, sessionId, userId, action: 'read' });
    if (session?.status !== 'deleting') return null;

    return parseDeletion(session);
  }
}

/** Finds due cleanup requests even after queue loss or an interrupted previous attempt. */
export async function listSessionDeletions(db: Database): Promise<readonly string[]> {
  const rows = await db
    .select({ id: AGENT_SESSIONS.id })
    .from(AGENT_SESSIONS)
    .where(
      and(
        eq(AGENT_SESSIONS.status, 'deleting'),
        lte(AGENT_SESSIONS.cleanupAfter, sql`clock_timestamp()`),
      ),
    )
    .orderBy(AGENT_SESSIONS.cleanupAfter, AGENT_SESSIONS.id)
    .limit(100);

  return rows.map((row) => row.id);
}

/** Retries idempotent resource release before atomically removing the Session and its Inbox. */
export async function processSessionDeletion({
  db,
  sessionId,
  deleteResources,
  signal,
}: {
  db: Database;
  sessionId: string;
  deleteResources: DeleteSessionResources;
  signal?: AbortSignal;
}): Promise<void> {
  if (signal?.aborted) return;

  // A short claim limits duplicate cleanup. Its expiry needs no owner transfer: deletion is idempotent.
  const [session] = await db
    .update(AGENT_SESSIONS)
    .set({
      cleanupAttempts: sql`${AGENT_SESSIONS.cleanupAttempts} + 1`,
      cleanupAfter: sql`clock_timestamp() + ${CLEANUP_ATTEMPT_TIMEOUT_SECONDS} * interval '1 second'`,
    })
    .where(
      and(
        eq(AGENT_SESSIONS.id, sessionId),
        eq(AGENT_SESSIONS.status, 'deleting'),
        lte(AGENT_SESSIONS.cleanupAfter, sql`clock_timestamp()`),
      ),
    )
    .returning();
  if (!session) return;

  // A claim can wait on PostgreSQL while its Worker stops. Do not start new resource I/O afterward.
  if (signal?.aborted) {
    await db
      .update(AGENT_SESSIONS)
      .set({ cleanupAfter: sql`clock_timestamp()` })
      .where(and(eq(AGENT_SESSIONS.id, sessionId), eq(AGENT_SESSIONS.status, 'deleting')));
    return;
  }

  try {
    // No transaction is held across provider, filesystem or Redis I/O.
    await deleteResources({ sessionId, sandboxId: session.sandboxId });
    await finalizeSessionDeletion(db, sessionId);
  } catch (error) {
    await recordCleanupFailure({ db, sessionId, attempts: session.cleanupAttempts, error });
  }
}

async function finalizeSessionDeletion(db: Database, sessionId: string) {
  await db.transaction(finalize);

  async function finalize(transaction: DatabaseTransaction) {
    const [session] = await transaction
      .select({ id: AGENT_SESSIONS.id })
      .from(AGENT_SESSIONS)
      .where(and(eq(AGENT_SESSIONS.id, sessionId), eq(AGENT_SESSIONS.status, 'deleting')))
      .for('update');
    if (!session) return;

    // Cascaded Runs must release their Inbox foreign keys before the scoped input is removed.
    await transaction.delete(AGENT_SESSIONS).where(eq(AGENT_SESSIONS.id, sessionId));
    await transaction.delete(INBOX_EVENTS).where(eq(INBOX_EVENTS.scopeId, sessionId));
  }
}

async function recordCleanupFailure({
  db,
  sessionId,
  attempts,
  error,
}: {
  db: Database;
  sessionId: string;
  attempts: number;
  error: unknown;
}): Promise<never> {
  const failure = new Error(`Session ${sessionId} resource cleanup failed`, { cause: error });
  const delaySeconds = Math.min(MAX_CLEANUP_RETRY_SECONDS, 2 ** attempts);
  try {
    await db
      .update(AGENT_SESSIONS)
      .set({
        cleanupAfter: sql`clock_timestamp() + ${delaySeconds} * interval '1 second'`,
        // A stable code supports translated clients; provider diagnostics remain in logs.
        cleanupError: 'resource_cleanup_failed',
      })
      .where(and(eq(AGENT_SESSIONS.id, sessionId), eq(AGENT_SESSIONS.status, 'deleting')));
  } catch (recordingError) {
    throw new AggregateError(
      [failure, recordingError],
      `Session ${sessionId} cleanup failure could not be recorded`,
    );
  }

  throw failure;
}

function parseDeletion(row: typeof AGENT_SESSIONS.$inferSelect) {
  return SESSION_DELETION_SCHEMA.parse({
    sessionId: row.id,
    status: row.status,
    requestedAt: row.deletionRequestedAt?.toISOString(),
    attempts: row.cleanupAttempts,
    nextAttemptAt: row.cleanupAfter?.toISOString(),
    errorCode: row.cleanupError,
  });
}
