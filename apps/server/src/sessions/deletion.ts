import {
  type AgentRun,
  SESSION_DELETION_SCHEMA,
  type SessionDeletion,
} from '@always-on/contracts/agents';
import { and, desc, eq, inArray, lte, ne, notExists, type SQL, sql } from 'drizzle-orm';
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
const DELETION_BLOCKING_RUNS = [
  'queued',
  'running',
  'cancelling',
  'recovery_required',
] as const satisfies readonly AgentRun['status'][];
const DELETION_PROGRESS_FIELDS = {
  id: AGENT_SESSIONS.id,
  status: AGENT_SESSIONS.status,
  deletionRequestedAt: AGENT_SESSIONS.deletionRequestedAt,
  cleanupAfter: AGENT_SESSIONS.cleanupAfter,
  cleanupAttempts: AGENT_SESSIONS.cleanupAttempts,
  cleanupError: AGENT_SESSIONS.cleanupError,
};
type DeletionProgress = Pick<
  typeof AGENT_SESSIONS.$inferSelect,
  keyof typeof DELETION_PROGRESS_FIELDS
>;

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
          inArray(AGENT_RUNS.status, DELETION_BLOCKING_RUNS),
        ),
      )
      .orderBy(desc(sql`${AGENT_RUNS.status} = 'recovery_required'`))
      .limit(1);
    if (blocker)
      return { status: blocker.status === 'recovery_required' ? 'recovery_required' : 'busy' };

    const [requested] = await startSessionDeletion(transaction, [sessionId]);
    if (!requested) throw new Error(`Session ${sessionId} disappeared during deletion request`);

    return { status: 'accepted', deletion: parseDeletion(requested) };
  }
}

/** Advances Sessions already locked and checked for outstanding execution. */
export async function startSessionDeletion(
  transaction: DatabaseTransaction,
  sessionIds: readonly string[],
): Promise<readonly DeletionProgress[]> {
  if (sessionIds.length === 0) return [];

  return transaction
    .update(AGENT_SESSIONS)
    .set({
      status: 'deleting',
      deletionRequestedAt: sql`clock_timestamp()`,
      cleanupAfter: sql`clock_timestamp()`,
      revision: sql`${AGENT_SESSIONS.revision} + 1`,
    })
    .where(
      and(
        inArray(AGENT_SESSIONS.id, sessionIds),
        ne(AGENT_SESSIONS.status, 'deleting'),
        hasNoBlockingRuns(transaction),
      ),
    )
    .returning(DELETION_PROGRESS_FIELDS);
}

/** Selects only Sessions whose associated Runs all reached a known boundary. */
export function hasNoBlockingRuns(transaction: DatabaseTransaction): SQL {
  const blockers = transaction
    .select({ id: AGENT_RUNS.id })
    .from(AGENT_RUNS)
    .where(
      and(
        eq(AGENT_RUNS.sessionId, AGENT_SESSIONS.id),
        inArray(AGENT_RUNS.status, DELETION_BLOCKING_RUNS),
      ),
    );

  return notExists(blockers);
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

  // Resource deletion is idempotent, but only the latest attempt may reschedule its retry.
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
    .returning({ sandboxId: AGENT_SESSIONS.sandboxId, attempts: AGENT_SESSIONS.cleanupAttempts });
  if (!session) return;

  // A claim can wait on PostgreSQL while its Worker stops. Do not start new resource I/O afterward.
  if (signal?.aborted) {
    await db
      .update(AGENT_SESSIONS)
      .set({ cleanupAfter: sql`clock_timestamp()` })
      .where(
        and(
          eq(AGENT_SESSIONS.id, sessionId),
          eq(AGENT_SESSIONS.status, 'deleting'),
          eq(AGENT_SESSIONS.cleanupAttempts, session.attempts),
        ),
      );
    return;
  }

  try {
    // No transaction is held across provider, filesystem or Redis I/O.
    await deleteResources({ sessionId, sandboxId: session.sandboxId });
    await finalizeSessionDeletion(db, sessionId);
  } catch (error) {
    await recordCleanupFailure({ db, sessionId, attempts: session.attempts, error });
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
      .where(
        and(
          eq(AGENT_SESSIONS.id, sessionId),
          eq(AGENT_SESSIONS.status, 'deleting'),
          eq(AGENT_SESSIONS.cleanupAttempts, attempts),
        ),
      );
  } catch (recordingError) {
    throw new AggregateError(
      [failure, recordingError],
      `Session ${sessionId} cleanup failure could not be recorded`,
    );
  }

  throw failure;
}

function parseDeletion(row: DeletionProgress) {
  return SESSION_DELETION_SCHEMA.parse({
    sessionId: row.id,
    status: row.status,
    requestedAt: row.deletionRequestedAt?.toISOString(),
    attempts: row.cleanupAttempts,
    nextAttemptAt: row.cleanupAfter?.toISOString(),
    errorCode: row.cleanupError,
  });
}
