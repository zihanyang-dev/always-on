import type { ExecutionCheckpoint } from '@always-on/agent-runtime/execution';
import {
  AGENT_MESSAGE_SCHEMA,
  type AgentMessage,
  type AgentRun,
} from '@always-on/contracts/agents';
import { and, eq, sql } from 'drizzle-orm';
import { readUsableAgent } from '../agents/index.js';
import {
  AGENT_MESSAGES,
  AGENT_RUNS,
  AGENT_SESSIONS,
  AGENT_TOOL_CALLS,
  type Database,
  type DatabaseTransaction,
} from '../infrastructure/database/index.js';
import {
  advanceRevision,
  getOwnedRunFilter,
  parseRun,
  type RunClaim,
  requireOwnership,
} from './ownership.js';

/** Final facts committed only after execution and resource cleanup have finished. */
export type RunCompletion =
  | { readonly status: 'completed' | 'cancelled'; readonly checkpoint: ExecutionCheckpoint | null }
  | {
      readonly status: 'failed';
      readonly error: string;
      readonly checkpoint: ExecutionCheckpoint | null;
    }
  | { readonly status: 'recovery_required'; readonly error: string };

/** A durable stop request is an expected access outcome rather than an infrastructure exception. */
export type RunToolAccess = { readonly status: 'allowed' | 'cancel_requested' };

/** Attaches the acknowledged VM identity before exposing tools to the model. */
export async function bindRunSandbox({
  db,
  claim,
  sandboxId,
}: {
  db: Database;
  claim: RunClaim;
  sandboxId: string;
}): Promise<void> {
  await db.transaction(async (transaction) => {
    await requireOwnership(transaction, claim);
    await transaction
      .update(AGENT_SESSIONS)
      .set({ sandboxId })
      .where(eq(AGENT_SESSIONS.id, claim.run.sessionId));
  });
}

/** Persists confirmed message boundaries, never provider-specific model context. */
export async function writeRunMessage({
  db,
  claim,
  message,
}: {
  db: Database;
  claim: RunClaim;
  message: {
    readonly index: number;
    readonly role: 'assistant' | 'tool';
    readonly state: AgentMessage['state'];
    readonly text: string;
  };
}): Promise<AgentMessage> {
  return db.transaction(async (transaction) => {
    await requireOwnership(transaction, claim);
    const [saved] = await transaction
      .insert(AGENT_MESSAGES)
      .values({
        sessionId: claim.run.sessionId,
        runId: claim.run.id,
        messageIndex: message.index,
        role: message.role,
        state: message.state,
        text: message.text,
      })
      .onConflictDoUpdate({
        target: [AGENT_MESSAGES.runId, AGENT_MESSAGES.messageIndex],
        set: { text: message.text, state: message.state },
      })
      .returning();
    if (!saved) throw new Error(`Run ${claim.run.id} message ${message.index} returned no row`);
    await advanceRevision(transaction, claim.run.sessionId);
    return AGENT_MESSAGE_SCHEMA.parse(saved);
  });
}

/** Commits an authorized tool intent before an external side effect may occur. */
export async function startRunTool({
  db,
  claim,
  tool,
}: {
  db: Database;
  claim: RunClaim;
  tool: { readonly id: string; readonly name: string };
}): Promise<RunToolAccess> {
  return db.transaction(async (transaction) => {
    const access = await readToolAccess(transaction, claim);
    if (access.status === 'cancel_requested') return access;
    await transaction.insert(AGENT_TOOL_CALLS).values({
      id: tool.id,
      runId: claim.run.id,
      name: tool.name,
      status: 'pending',
    });
    return access;
  });
}

/** Checks read-only tools against the same current execution authority as side effects. */
export async function authorizeRunTool({
  db,
  claim,
}: {
  db: Database;
  claim: RunClaim;
}): Promise<RunToolAccess> {
  return db.transaction((transaction) => readToolAccess(transaction, claim));
}

/** Records a tool's acknowledgement; a failure leaves its intent pending for reconciliation. */
export async function finishRunTool({
  db,
  claim,
  toolId,
}: {
  db: Database;
  claim: RunClaim;
  toolId: string;
}): Promise<void> {
  await db.transaction(async (transaction) => {
    await requireOwnership(transaction, claim);
    const acknowledged = await transaction
      .update(AGENT_TOOL_CALLS)
      .set({ status: 'completed', finishedAt: sql`clock_timestamp()` })
      .where(and(eq(AGENT_TOOL_CALLS.id, toolId), eq(AGENT_TOOL_CALLS.runId, claim.run.id)))
      .returning({ id: AGENT_TOOL_CALLS.id });
    if (acknowledged.length !== 1)
      throw new Error(`Run ${claim.run.id} tool ${toolId} has no recorded intent`);
  });
}

/** Atomically promotes a native checkpoint and closes the fenced Run. */
export async function completeRun({
  db,
  claim,
  completion,
}: {
  db: Database;
  claim: RunClaim;
  completion: RunCompletion;
}): Promise<AgentRun> {
  return db.transaction(async (transaction) => {
    const session = await requireOwnership(transaction, claim);
    const [current] = await transaction
      .select({ status: AGENT_RUNS.status })
      .from(AGENT_RUNS)
      .where(getOwnedRunFilter(claim));
    if (!current) throw new Error(`Run ${claim.run.id} lost ownership before completion`);
    const agent = await readUsableAgent({
      transaction,
      agentId: session.agentId,
      userId: claim.userId,
    });
    const shouldCancel = current.status === 'cancelling' || !agent;
    // A committed cancellation wins a race with an otherwise successful model response.
    const outcome =
      shouldCancel && completion.status === 'completed'
        ? { ...completion, status: 'cancelled' as const }
        : completion;
    const [pending] = await transaction
      .select({ id: AGENT_TOOL_CALLS.id })
      .from(AGENT_TOOL_CALLS)
      .where(and(eq(AGENT_TOOL_CALLS.runId, claim.run.id), eq(AGENT_TOOL_CALLS.status, 'pending')))
      .limit(1);
    const result = pending
      ? {
          status: 'recovery_required' as const,
          error: `Tool ${pending.id} has no acknowledged result`,
        }
      : outcome;
    const [updated] = await transaction
      .update(AGENT_RUNS)
      .set({
        status: result.status,
        finishedAt: sql`clock_timestamp()`,
        ...('error' in result ? { error: result.error } : {}),
      })
      .where(getOwnedRunFilter(claim))
      .returning();
    if (!updated) throw new Error(`Run ${claim.run.id} lost ownership before completion`);
    await transaction
      .update(AGENT_MESSAGES)
      .set({ state: 'interrupted' })
      .where(and(eq(AGENT_MESSAGES.runId, claim.run.id), eq(AGENT_MESSAGES.state, 'pending')));
    const checkpoint = 'checkpoint' in result ? result.checkpoint : null;
    await transaction
      .update(AGENT_SESSIONS)
      .set({
        ...(checkpoint ? { checkpoint } : {}),
        revision: sql`${AGENT_SESSIONS.revision} + 1`,
      })
      .where(eq(AGENT_SESSIONS.id, claim.run.sessionId));
    return parseRun(updated);
  });
}

async function readToolAccess(
  transaction: DatabaseTransaction,
  claim: RunClaim,
): Promise<RunToolAccess> {
  const session = await requireOwnership(transaction, claim);
  const agent = await readUsableAgent({
    transaction,
    agentId: session.agentId,
    userId: claim.userId,
  });
  if (!agent) return { status: 'cancel_requested' };
  const [run] = await transaction
    .select({ status: AGENT_RUNS.status })
    .from(AGENT_RUNS)
    .where(getOwnedRunFilter(claim));
  if (!run) throw new Error(`Run ${claim.run.id} execution lease is no longer owned`);
  return { status: run.status === 'running' ? 'allowed' : 'cancel_requested' };
}
