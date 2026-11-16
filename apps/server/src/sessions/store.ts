import type {
  AgentConfiguration,
  AgentRun,
  AgentSession,
  SUBMIT_MESSAGE_SCHEMA,
  UpdateSession,
} from '@always-on/contracts/agents';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { readUsableAgent } from '../agents/index.js';
import {
  AGENT_MESSAGES,
  AGENT_RUNS,
  AGENT_SESSIONS,
  type Database,
  type DatabaseTransaction,
  INBOX_EVENTS,
} from '../infrastructure/database/index.js';
import { readSessionAccess, type SessionAccess } from './access.js';
import { parseRun, parseSession } from './records.js';

type MessageInput = z.infer<typeof SUBMIT_MESSAGE_SCHEMA>;
interface SessionConfigurationChange extends SessionAccess {
  configuration: AgentConfiguration;
}
interface SessionMessageSubmission extends SessionAccess {
  input: MessageInput;
}
interface SessionRunCancellation extends SessionAccess {
  runId: string;
}

interface SessionMetadataChange extends SessionAccess {
  readonly patch: UpdateSession;
}

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
  return db.transaction(create);

  async function create(transaction: DatabaseTransaction) {
    const agent = await readUsableAgent({ transaction, agentId, userId });
    if (!agent) return null;

    // Snapshot execution settings without copying the Agent's identity or visibility.
    const configuration = {
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      instructions: agent.instructions,
    } satisfies AgentConfiguration;
    const [session] = await transaction
      .insert(AGENT_SESSIONS)
      .values({ agentId, workspaceId: agent.workspaceId, createdBy: userId, configuration })
      .returning();
    if (!session) throw new Error(`Session creation for Agent ${agentId} returned no row`);

    return parseSession(session);
  }
}

/** Changes subsequent Run defaults; already admitted Runs retain their own configuration. */
export async function updateSessionConfiguration({
  db,
  sessionId,
  userId,
  configuration,
}: SessionConfigurationChange): Promise<AgentSession | null> {
  return db.transaction(update);

  async function update(transaction: DatabaseTransaction) {
    // Serialize default changes with admission so each Run captures one complete configuration.
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'use' });
    if (!session) return null;

    const [updated] = await transaction
      .update(AGENT_SESSIONS)
      .set({ configuration, revision: sql`${AGENT_SESSIONS.revision} + 1` })
      .where(eq(AGENT_SESSIONS.id, sessionId))
      .returning();
    if (!updated) throw new Error(`Session ${sessionId} disappeared during configuration update`);

    return parseSession(updated);
  }
}

/** Updates personal organization without granting access to another user's conversation. */
export async function updateAgentSession({
  db,
  sessionId,
  userId,
  patch,
}: SessionMetadataChange): Promise<AgentSession | null> {
  return db.transaction(update);

  async function update(transaction: DatabaseTransaction) {
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'manage' });
    if (!session) return null;

    // Archiving organizes history; already admitted work keeps its independent Run lifecycle.
    const [updated] = await transaction
      .update(AGENT_SESSIONS)
      .set({ ...patch, revision: sql`${AGENT_SESSIONS.revision} + 1` })
      .where(eq(AGENT_SESSIONS.id, sessionId))
      .returning();
    if (!updated) throw new Error(`Session ${sessionId} disappeared during metadata update`);

    return parseSession(updated);
  }
}

/** Commits Inbox input, queued Run and the user's display message in one transaction. */
export async function submitSessionMessage({
  db,
  sessionId,
  userId,
  input,
}: SessionMessageSubmission): Promise<MessageSubmission> {
  return db.transaction(submit);

  async function submit(transaction: DatabaseTransaction): Promise<MessageSubmission> {
    // One Session lock serializes retries and configuration snapshots with competing submissions.
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'use' });
    if (!session) return { status: 'not_found' };

    const repeated = await readRepeatedSubmission({ transaction, sessionId, input });
    if (repeated) return repeated;

    // Retries keep their original identity, even after a later Run requires recovery.
    if (await hasUncertainRun(transaction, sessionId)) return { status: 'recovery_required' };

    const run = await recordSessionInput({
      transaction,
      sessionId,
      configuration: session.configuration,
      input,
    });

    return { status: 'accepted', run };
  }
}

/** Persists cancellation; disconnecting an event subscription never calls this operation. */
export async function cancelSessionRun({
  db,
  sessionId,
  runId,
  userId,
}: SessionRunCancellation): Promise<AgentRun | null> {
  return db.transaction(cancel);

  async function cancel(transaction: DatabaseTransaction) {
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'manage' });
    if (!session) return null;

    const [run] = await transaction
      .select()
      .from(AGENT_RUNS)
      .where(and(eq(AGENT_RUNS.id, runId), eq(AGENT_RUNS.sessionId, sessionId)));
    if (!run) return null;
    if (run.status !== 'queued' && run.status !== 'running') return parseRun(run);

    // Queued work has no executor; active work must acknowledge cancellation before it can finish.
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
  }
}

async function hasUncertainRun(transaction: DatabaseTransaction, sessionId: string) {
  // An unresolved effect blocks later input throughout this conversation, not just the latest Run.
  const [run] = await transaction
    .select({ id: AGENT_RUNS.id })
    .from(AGENT_RUNS)
    .where(and(eq(AGENT_RUNS.sessionId, sessionId), eq(AGENT_RUNS.status, 'recovery_required')))
    .limit(1);

  return run !== undefined;
}

async function readRepeatedSubmission({
  transaction,
  sessionId,
  input,
}: {
  transaction: DatabaseTransaction;
  sessionId: string;
  input: MessageInput;
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

async function recordSessionInput({
  transaction,
  sessionId,
  configuration,
  input,
}: {
  transaction: DatabaseTransaction;
  sessionId: string;
  configuration: AgentConfiguration;
  input: MessageInput;
}) {
  // These records form one admission; publishing only a subset would lose or duplicate work.
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
    .values({ sessionId, inputId: event.id, inputText: input.text, configuration })
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
  // A genuinely new input resumes an archived conversation; a duplicate remains a read of its Run.
  await transaction
    .update(AGENT_SESSIONS)
    .set({ status: 'active', revision: sql`${AGENT_SESSIONS.revision} + 1` })
    .where(eq(AGENT_SESSIONS.id, sessionId));

  return parseRun(run);
}

async function advanceRevision(transaction: DatabaseTransaction, sessionId: string) {
  // Heartbeats reconcile committed changes even when the corresponding Redis publication is lost.
  await transaction
    .update(AGENT_SESSIONS)
    .set({ revision: sql`${AGENT_SESSIONS.revision} + 1` })
    .where(eq(AGENT_SESSIONS.id, sessionId));
}
