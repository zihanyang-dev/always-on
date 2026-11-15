import {
  AGENT_CONFIGURATION_SCHEMA,
  AGENT_MESSAGE_SCHEMA,
  AGENT_RUN_SCHEMA,
  AGENT_SESSION_SCHEMA,
  type AgentConfiguration,
  type AgentRun,
  type AgentSession,
  type SessionSnapshot,
} from '@always-on/contracts/agents';
import { and, desc, eq, sql } from 'drizzle-orm';
import { readUsableAgent } from '../agents/index.js';
import {
  AGENT_MESSAGES,
  AGENT_RUNS,
  AGENT_SESSIONS,
  type Database,
  type DatabaseTransaction,
  INBOX_EVENTS,
  WORKSPACE_MEMBERS,
} from '../infrastructure/database/index.js';
import { hasAgentPermission } from '../workspaces/index.js';

type SessionRow = typeof AGENT_SESSIONS.$inferSelect;
type RunRow = typeof AGENT_RUNS.$inferSelect;

/** A submission either reuses its original Run or creates exactly one durable dispatch intent. */
export type MessageSubmission =
  | { readonly status: 'accepted' | 'duplicate'; readonly run: AgentRun }
  | { readonly status: 'not_found' | 'conflict' | 'recovery_required' };

/** Creates a private conversation from the accessible Agent's current defaults. */
export async function createAgentSession({
  db,
  agentId,
  userId,
}: {
  db: Database;
  agentId: string;
  userId: string;
}): Promise<AgentSession | null> {
  return db.transaction(async (transaction) => {
    const agent = await readUsableAgent({ transaction, agentId, userId });
    if (!agent) return null;
    const [session] = await transaction
      .insert(AGENT_SESSIONS)
      .values({
        agentId,
        workspaceId: agent.workspaceId,
        createdBy: userId,
        configuration: {
          model: agent.model,
          reasoningEffort: agent.reasoningEffort,
          instructions: agent.instructions,
        },
      })
      .returning();
    if (!session) throw new Error(`Session creation for Agent ${agentId} returned no row`);
    return parseSession(session);
  });
}

/** Changes subsequent Run defaults; already admitted Runs retain their own configuration. */
export async function updateSessionConfiguration({
  db,
  sessionId,
  userId,
  configuration,
}: {
  db: Database;
  sessionId: string;
  userId: string;
  configuration: AgentConfiguration;
}): Promise<AgentSession | null> {
  return db.transaction(async (transaction) => {
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'use' });
    if (!session) return null;
    const [updated] = await transaction
      .update(AGENT_SESSIONS)
      .set({ configuration, revision: sql`${AGENT_SESSIONS.revision} + 1` })
      .where(eq(AGENT_SESSIONS.id, sessionId))
      .returning();
    if (!updated) throw new Error(`Session ${sessionId} disappeared during configuration update`);
    return parseSession(updated);
  });
}

/** Reads a consistent durable display view while execution writes wait on the session lock. */
export async function readSessionSnapshot({
  db,
  sessionId,
  userId,
}: {
  db: Database;
  sessionId: string;
  userId: string;
}): Promise<SessionSnapshot | null> {
  return db.transaction(async (transaction) => {
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'read' });
    if (!session) return null;
    const [runs, messages] = await Promise.all([
      transaction
        .select()
        .from(AGENT_RUNS)
        .where(eq(AGENT_RUNS.sessionId, sessionId))
        .orderBy(
          desc(sql`${AGENT_RUNS.status} in ('running', 'cancelling')`),
          desc(AGENT_RUNS.createdAt),
          desc(AGENT_RUNS.id),
        )
        .limit(1),
      transaction
        .select()
        .from(AGENT_MESSAGES)
        .where(eq(AGENT_MESSAGES.sessionId, sessionId))
        .orderBy(AGENT_MESSAGES.position),
    ]);
    const [run] = runs;
    return {
      session: parseSession(session),
      run: run ? parseRun(run) : null,
      messages: messages.map((message) => AGENT_MESSAGE_SCHEMA.parse(message)),
    };
  });
}

/** Rechecks access during a long-lived subscription without loading the message history. */
export async function canReadSession({
  db,
  sessionId,
  userId,
}: {
  db: Database;
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'read' });
    return Boolean(session);
  });
}

/** Commits Inbox input, queued Run and the user's display message in one transaction. */
export async function submitSessionMessage({
  db,
  sessionId,
  userId,
  input,
}: {
  db: Database;
  sessionId: string;
  userId: string;
  input: { readonly sourceEventId: string; readonly text: string };
}): Promise<MessageSubmission> {
  return db.transaction(async (transaction) => {
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'use' });
    if (!session) return { status: 'not_found' };
    const existing = await readRepeatedSubmission({ transaction, sessionId, input });
    if (existing) return existing;
    const [uncertain] = await transaction
      .select({ id: AGENT_RUNS.id })
      .from(AGENT_RUNS)
      .where(and(eq(AGENT_RUNS.sessionId, sessionId), eq(AGENT_RUNS.status, 'recovery_required')))
      .limit(1);
    if (uncertain) return { status: 'recovery_required' };
    const [event] = await transaction
      .insert(INBOX_EVENTS)
      .values({
        scopeId: sessionId,
        source: 'web',
        sourceEventId: input.sourceEventId,
        payload: input,
      })
      .returning({ id: INBOX_EVENTS.id });
    if (!event) throw new Error(`Inbox submission for session ${sessionId} returned no row`);
    const [run] = await transaction
      .insert(AGENT_RUNS)
      .values({
        sessionId,
        inputId: event.id,
        inputText: input.text,
        configuration: session.configuration,
      })
      .returning();
    if (!run) throw new Error(`Run admission for session ${sessionId} returned no row`);
    await transaction.insert(AGENT_MESSAGES).values({
      sessionId,
      runId: run.id,
      messageIndex: -1,
      role: 'user',
      state: 'completed',
      text: input.text,
    });
    await advanceRevision(transaction, sessionId);
    return { status: 'accepted', run: parseRun(run) };
  });
}

/** Persists cancellation; disconnecting an event subscription never calls this operation. */
export async function cancelSessionRun({
  db,
  sessionId,
  runId,
  userId,
}: {
  db: Database;
  sessionId: string;
  runId: string;
  userId: string;
}): Promise<AgentRun | null> {
  return db.transaction(async (transaction) => {
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'use' });
    if (!session) return null;
    const [run] = await transaction
      .select()
      .from(AGENT_RUNS)
      .where(and(eq(AGENT_RUNS.id, runId), eq(AGENT_RUNS.sessionId, sessionId)));
    if (!run) return null;
    if (run.status !== 'queued' && run.status !== 'running') return parseRun(run);
    const change =
      run.status === 'queued'
        ? { status: 'cancelled' as const, finishedAt: sql`clock_timestamp()` }
        : { status: 'cancelling' as const };
    const [updated] = await transaction
      .update(AGENT_RUNS)
      .set(change)
      .where(eq(AGENT_RUNS.id, runId))
      .returning();
    if (!updated) throw new Error(`Run ${runId} disappeared during cancellation`);
    await advanceRevision(transaction, sessionId);
    return parseRun(updated);
  });
}

async function readSessionAccess({
  transaction,
  sessionId,
  userId,
  action,
}: {
  transaction: DatabaseTransaction;
  sessionId: string;
  userId: string;
  action: 'read' | 'use';
}) {
  const [session] = await transaction
    .select()
    .from(AGENT_SESSIONS)
    .where(and(eq(AGENT_SESSIONS.id, sessionId), eq(AGENT_SESSIONS.createdBy, userId)))
    .for(action === 'read' ? 'share' : 'update');
  if (!session) return null;
  const [membership] = await transaction
    .select({ roles: WORKSPACE_MEMBERS.role })
    .from(WORKSPACE_MEMBERS)
    .where(
      and(
        eq(WORKSPACE_MEMBERS.organizationId, session.workspaceId),
        eq(WORKSPACE_MEMBERS.userId, userId),
      ),
    )
    .for('share');
  if (!membership || !hasAgentPermission({ roles: membership.roles, action })) return null;
  if (action === 'read') return session;
  const agent = await readUsableAgent({ transaction, agentId: session.agentId, userId });
  return agent ? session : null;
}

async function readRepeatedSubmission({
  transaction,
  sessionId,
  input,
}: {
  transaction: DatabaseTransaction;
  sessionId: string;
  input: { readonly sourceEventId: string; readonly text: string };
}): Promise<MessageSubmission | null> {
  const [existing] = await transaction
    .select({ run: AGENT_RUNS })
    .from(INBOX_EVENTS)
    .innerJoin(AGENT_RUNS, eq(AGENT_RUNS.inputId, INBOX_EVENTS.id))
    .where(
      and(
        eq(INBOX_EVENTS.scopeId, sessionId),
        eq(INBOX_EVENTS.source, 'web'),
        eq(INBOX_EVENTS.sourceEventId, input.sourceEventId),
      ),
    );
  if (!existing) return null;
  if (existing.run.inputText !== input.text) return { status: 'conflict' };
  return { status: 'duplicate', run: parseRun(existing.run) };
}

async function advanceRevision(transaction: DatabaseTransaction, sessionId: string) {
  await transaction
    .update(AGENT_SESSIONS)
    .set({ revision: sql`${AGENT_SESSIONS.revision} + 1` })
    .where(eq(AGENT_SESSIONS.id, sessionId));
}

function parseSession(row: SessionRow) {
  const configuration = AGENT_CONFIGURATION_SCHEMA.parse(row.configuration);
  return AGENT_SESSION_SCHEMA.parse({
    ...row,
    configuration,
    createdAt: row.createdAt.toISOString(),
  });
}

function parseRun(row: RunRow) {
  return AGENT_RUN_SCHEMA.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  });
}
