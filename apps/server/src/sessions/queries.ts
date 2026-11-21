import {
  AGENT_MESSAGE_SCHEMA,
  SESSION_LIST_PAGE_SCHEMA,
  SESSION_PAGE_SIZE,
  type SessionHistoryQuery,
  type SessionListPage,
  type SessionListQuery,
  type SessionMessagePage,
  type SessionSnapshot,
} from '@always-on/contracts/agents';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import {
  AGENT_MESSAGES,
  AGENT_RUNS,
  AGENT_SESSIONS,
  type Database,
  type DatabaseTransaction,
} from '../infrastructure/database/index.js';
import { hasWorkspaceSessionAccess, readSessionAccess, type SessionAccess } from './access.js';
import { parseRun } from './records.js';

type PageReadFailure = { readonly status: 'not_found' | 'invalid_cursor' };
interface SessionHistoryAccess extends SessionAccess {
  readonly query: SessionHistoryQuery;
}

/** A private conversation page or an expected access/cursor failure. */
export type SessionListResult =
  | { readonly status: 'found'; readonly page: SessionListPage }
  | PageReadFailure;

/** A durable message page or an expected access/cursor failure. */
export type SessionHistoryResult =
  | { readonly status: 'found'; readonly page: SessionMessagePage }
  | PageReadFailure;

/** Lists only the caller's conversations, with a scoped keyset cursor and current execution state. */
export async function listAgentSessions({
  db,
  userId,
  query: { workspaceId, cursor, limit, status },
}: {
  db: Database;
  userId: string;
  query: SessionListQuery;
}): Promise<SessionListResult> {
  return db.transaction(read);

  async function read(transaction: DatabaseTransaction): Promise<SessionListResult> {
    const hasAccess = await hasWorkspaceSessionAccess({
      transaction,
      workspaceId,
      userId,
      action: 'read',
    });
    if (!hasAccess) return { status: 'not_found' };

    const boundary = cursor
      ? await readSessionBoundary({ transaction, workspaceId, userId, cursor })
      : null;
    if (cursor && !boundary) return { status: 'invalid_cursor' };

    // Compare the database timestamp without a Date round trip: PostgreSQL retains microseconds.
    const before = boundary
      ? sql`(${AGENT_SESSIONS.createdAt}, ${AGENT_SESSIONS.id}) < (${boundary.createdAt}::timestamptz, ${cursor}::uuid)`
      : undefined;
    const currentRun = selectCurrentRun(transaction, AGENT_SESSIONS.id).as('current_run');
    const runFields = {
      id: currentRun.id,
      sessionId: currentRun.sessionId,
      createdAt: currentRun.createdAt,
      status: currentRun.status,
      startedAt: currentRun.startedAt,
      finishedAt: currentRun.finishedAt,
      error: currentRun.error,
    };
    const rows = await transaction
      .select({
        id: AGENT_SESSIONS.id,
        agentId: AGENT_SESSIONS.agentId,
        workspaceId: AGENT_SESSIONS.workspaceId,
        createdAt: AGENT_SESSIONS.createdAt,
        title: AGENT_SESSIONS.title,
        status: AGENT_SESSIONS.status,
        run: runFields,
      })
      .from(AGENT_SESSIONS)
      .leftJoinLateral(currentRun, sql`true`)
      .where(
        and(
          eq(AGENT_SESSIONS.workspaceId, workspaceId),
          eq(AGENT_SESSIONS.createdBy, userId),
          eq(AGENT_SESSIONS.status, status),
          before,
        ),
      )
      .orderBy(desc(AGENT_SESSIONS.createdAt), desc(AGENT_SESSIONS.id))
      .limit(limit + 1);
    const sessions = rows.slice(0, limit).map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      run: row.run ? parseRun(row.run) : null,
    }));
    const nextCursor = rows.length > limit ? (sessions.at(-1)?.id ?? null) : null;

    return { status: 'found', page: SESSION_LIST_PAGE_SCHEMA.parse({ sessions, nextCursor }) };
  }
}

/** Reads older durable messages while holding the same access locks as a Session snapshot. */
export async function readSessionHistory({
  db,
  sessionId,
  userId,
  query: { cursor, limit },
}: SessionHistoryAccess): Promise<SessionHistoryResult> {
  return db.transaction(read);

  async function read(transaction: DatabaseTransaction): Promise<SessionHistoryResult> {
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'read' });
    if (!session) return { status: 'not_found' };

    const [boundary] = cursor
      ? await transaction
          .select({ position: AGENT_MESSAGES.position })
          .from(AGENT_MESSAGES)
          .where(and(eq(AGENT_MESSAGES.id, cursor), eq(AGENT_MESSAGES.sessionId, sessionId)))
      : [];
    if (cursor && !boundary) return { status: 'invalid_cursor' };

    const page = await readMessagePage({
      transaction,
      sessionId,
      limit,
      beforePosition: boundary?.position,
    });

    return { status: 'found', page };
  }
}

/** Reads one consistent latest message window, configuration and current Run for resynchronization. */
export async function readSessionSnapshot({
  db,
  sessionId,
  userId,
}: SessionAccess): Promise<SessionSnapshot | null> {
  return db.transaction(read);

  async function read(transaction: DatabaseTransaction) {
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'read' });
    if (!session) return null;

    // The shared Session lock keeps revision, messages and Run state consistent during this read.
    const [runs, page] = await Promise.all([
      selectCurrentRun(transaction, sessionId),
      readMessagePage({ transaction, sessionId, limit: SESSION_PAGE_SIZE }),
    ]);
    const [run] = runs;

    return { session, run: run ? parseRun(run) : null, ...page };
  }
}

/** Reads the display revision only while the caller retains current resource access. */
export async function readSessionRevision({
  db,
  sessionId,
  userId,
}: SessionAccess): Promise<number | null> {
  return db.transaction(read);

  async function read(transaction: DatabaseTransaction) {
    // Heartbeats repeat authorization; an earlier snapshot cannot grant permanent access.
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'read' });

    return session?.revision ?? null;
  }
}

async function readSessionBoundary({
  transaction,
  workspaceId,
  userId,
  cursor,
}: {
  transaction: DatabaseTransaction;
  workspaceId: string;
  userId: string;
  cursor: string;
}) {
  const [boundary] = await transaction
    .select({ createdAt: sql<string>`${AGENT_SESSIONS.createdAt}::text` })
    .from(AGENT_SESSIONS)
    .where(
      and(
        eq(AGENT_SESSIONS.id, cursor),
        eq(AGENT_SESSIONS.workspaceId, workspaceId),
        eq(AGENT_SESSIONS.createdBy, userId),
      ),
    );

  return boundary;
}

async function readMessagePage({
  transaction,
  sessionId,
  limit,
  beforePosition,
}: {
  transaction: DatabaseTransaction;
  sessionId: string;
  limit: number;
  beforePosition?: number | undefined;
}): Promise<SessionMessagePage> {
  const before =
    beforePosition === undefined ? undefined : lt(AGENT_MESSAGES.position, beforePosition);
  const rows = await transaction
    .select()
    .from(AGENT_MESSAGES)
    .where(and(eq(AGENT_MESSAGES.sessionId, sessionId), before))
    .orderBy(desc(AGENT_MESSAGES.position))
    .limit(limit + 1);
  const page = rows.slice(0, limit);

  return {
    messages: page.toReversed().map((row) => AGENT_MESSAGE_SCHEMA.parse(row)),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

function selectCurrentRun(
  transaction: DatabaseTransaction,
  sessionId: string | typeof AGENT_SESSIONS.id,
) {
  // A current owner or unresolved effect blocks queued input even if that input is newer.
  return transaction
    .select({
      id: AGENT_RUNS.id,
      sessionId: AGENT_RUNS.sessionId,
      createdAt: AGENT_RUNS.createdAt,
      status: AGENT_RUNS.status,
      startedAt: AGENT_RUNS.startedAt,
      finishedAt: AGENT_RUNS.finishedAt,
      error: AGENT_RUNS.error,
    })
    .from(AGENT_RUNS)
    .where(eq(AGENT_RUNS.sessionId, sessionId))
    .orderBy(
      desc(sql`${AGENT_RUNS.status} in ('running', 'cancelling', 'recovery_required')`),
      desc(AGENT_RUNS.admissionOrder),
    )
    .limit(1);
}
