import {
  EXECUTION_CHECKPOINT_SCHEMA,
  type ExecutionCheckpoint,
} from '@always-on/agent-runtime/execution';
import {
  type ActiveAgentRun,
  AGENT_CONFIGURATION_SCHEMA,
  AGENT_RUN_SCHEMA,
  type AgentConfiguration,
  type AgentRun,
} from '@always-on/contracts/agents';
import { and, asc, eq, gt, inArray, lt, notExists, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { readUsableAgent } from '../agents/index.js';
import {
  AGENT_MESSAGES,
  AGENT_RUNS,
  AGENT_SESSIONS,
  type Database,
  type DatabaseTransaction,
} from '../infrastructure/database/index.js';

const RUN_LEASE_DURATION_MS = 20_000;
type SessionRow = typeof AGENT_SESSIONS.$inferSelect;

/** A fenced claim, without a live SDK, model credential or database transaction. */
export type RunClaim = {
  readonly run: ActiveAgentRun;
  readonly ownerToken: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly configuration: AgentConfiguration;
  readonly text: string;
  readonly checkpoint: ExecutionCheckpoint | null;
  readonly sandboxId: string | null;
};

/** Claims the first queued input for a session, with current authorization and one database writer. */
export async function claimRun({
  db,
  runId,
  ownerToken,
}: {
  db: Database;
  runId: string;
  ownerToken: string;
}): Promise<RunClaim | null> {
  return db.transaction(async (transaction) => {
    const [candidate] = await transaction
      .select({ sessionId: AGENT_RUNS.sessionId })
      .from(AGENT_RUNS)
      .where(eq(AGENT_RUNS.id, runId));
    if (!candidate) return null;
    const session = await lockSession(transaction, candidate.sessionId);
    if (!session) return null;
    const [blocked] = await transaction
      .select({ id: AGENT_RUNS.id })
      .from(AGENT_RUNS)
      .where(
        and(
          eq(AGENT_RUNS.sessionId, session.id),
          inArray(AGENT_RUNS.status, ['running', 'cancelling', 'recovery_required']),
        ),
      )
      .limit(1);
    if (blocked) return null;
    const [next] = await transaction
      .select()
      .from(AGENT_RUNS)
      .where(and(eq(AGENT_RUNS.sessionId, session.id), eq(AGENT_RUNS.status, 'queued')))
      .orderBy(asc(AGENT_RUNS.createdAt), asc(AGENT_RUNS.id))
      .limit(1);
    if (!next || next.id !== runId) return null;
    const agent = await readUsableAgent({
      transaction,
      agentId: session.agentId,
      userId: session.createdBy,
    });
    if (!agent) {
      await transaction
        .update(AGENT_RUNS)
        .set({ status: 'cancelled', finishedAt: sql`clock_timestamp()` })
        .where(eq(AGENT_RUNS.id, runId));
      await advanceRevision(transaction, session.id);
      return null;
    }
    const [claimed] = await transaction
      .update(AGENT_RUNS)
      .set({
        status: 'running',
        ownerToken,
        startedAt: sql`clock_timestamp()`,
        leaseUntil: getLeaseDeadline(),
      })
      .where(eq(AGENT_RUNS.id, runId))
      .returning();
    if (!claimed) throw new Error(`Run ${runId} disappeared during claim`);
    const run = parseRun(claimed);
    if (run.status !== 'running') throw new Error(`Run ${runId} was not activated during claim`);
    await advanceRevision(transaction, session.id);
    return {
      run,
      ownerToken,
      userId: session.createdBy,
      workspaceId: session.workspaceId,
      text: next.inputText,
      configuration: AGENT_CONFIGURATION_SCHEMA.parse(next.configuration),
      checkpoint: EXECUTION_CHECKPOINT_SCHEMA.nullable().parse(session.checkpoint),
      sandboxId: session.sandboxId,
    };
  });
}

/** Renews ownership and observes durable cancellation or permission changes. */
export async function renewRun({
  db,
  claim,
}: {
  db: Database;
  claim: RunClaim;
}): Promise<'active' | 'cancel_requested' | 'lost'> {
  return db.transaction(async (transaction) => {
    const session = await lockSession(transaction, claim.run.sessionId);
    if (!session) return 'lost';
    const [run] = await transaction.select().from(AGENT_RUNS).where(getOwnedRunFilter(claim));
    if (!run) return 'lost';
    const agent = await readUsableAgent({
      transaction,
      agentId: session.agentId,
      userId: claim.userId,
    });
    const shouldCancel = run.status === 'cancelling' || !agent;
    const [renewed] = await transaction
      .update(AGENT_RUNS)
      .set({ leaseUntil: getLeaseDeadline(), status: shouldCancel ? 'cancelling' : 'running' })
      .where(getOwnedRunFilter(claim))
      .returning({ id: AGENT_RUNS.id });
    if (!renewed) return 'lost';
    return shouldCancel ? 'cancel_requested' : 'active';
  });
}

/** Finds durable dispatch intents independently of the state of Redis or a previous dispatcher. */
export async function listQueuedRuns(db: Database): Promise<readonly string[]> {
  const blocker = alias(AGENT_RUNS, 'blocking_run');
  const rows = await db
    .selectDistinctOn([AGENT_RUNS.sessionId], { id: AGENT_RUNS.id })
    .from(AGENT_RUNS)
    .where(
      and(
        eq(AGENT_RUNS.status, 'queued'),
        notExists(
          db
            .select({ id: blocker.id })
            .from(blocker)
            .where(
              and(
                eq(blocker.sessionId, AGENT_RUNS.sessionId),
                inArray(blocker.status, ['running', 'cancelling', 'recovery_required']),
              ),
            ),
        ),
      ),
    )
    .orderBy(AGENT_RUNS.sessionId, AGENT_RUNS.createdAt, AGENT_RUNS.id)
    .limit(100);
  return rows.map((row) => row.id);
}

/** Quarantines expired owners; a queue retry must never replay an uncertain SDK turn. */
export async function recoverExpiredRuns(db: Database): Promise<void> {
  const candidates = await db
    .select({ id: AGENT_RUNS.id, sessionId: AGENT_RUNS.sessionId })
    .from(AGENT_RUNS)
    .where(
      and(
        inArray(AGENT_RUNS.status, ['running', 'cancelling']),
        lt(AGENT_RUNS.leaseUntil, sql`clock_timestamp()`),
      ),
    )
    .limit(10);
  await Promise.all(candidates.map(recoverRun));

  async function recoverRun(candidate: { id: string; sessionId: string }) {
    await db.transaction(async (transaction) => {
      await lockSession(transaction, candidate.sessionId);
      const recovered = await transaction
        .update(AGENT_RUNS)
        .set({
          status: 'recovery_required',
          finishedAt: sql`clock_timestamp()`,
          error: `Run ${candidate.id} lost its execution owner; inspect native history and tool receipts before continuing`,
        })
        .where(
          and(
            eq(AGENT_RUNS.id, candidate.id),
            inArray(AGENT_RUNS.status, ['running', 'cancelling']),
            lt(AGENT_RUNS.leaseUntil, sql`clock_timestamp()`),
          ),
        )
        .returning({ id: AGENT_RUNS.id });
      if (recovered.length === 0) return;
      await transaction
        .update(AGENT_MESSAGES)
        .set({ state: 'interrupted' })
        .where(and(eq(AGENT_MESSAGES.runId, candidate.id), eq(AGENT_MESSAGES.state, 'pending')));
      await advanceRevision(transaction, candidate.sessionId);
    });
  }
}

async function lockSession(transaction: DatabaseTransaction, sessionId: string) {
  const [session] = await transaction
    .select()
    .from(AGENT_SESSIONS)
    .where(eq(AGENT_SESSIONS.id, sessionId))
    .for('update');
  return session;
}

export async function requireOwnership(
  transaction: DatabaseTransaction,
  claim: RunClaim,
): Promise<SessionRow> {
  const session = await lockSession(transaction, claim.run.sessionId);
  if (!session) throw new Error(`Run ${claim.run.id} session is unavailable`);
  const [run] = await transaction
    .select({ id: AGENT_RUNS.id })
    .from(AGENT_RUNS)
    .where(getOwnedRunFilter(claim));
  if (!run) throw new Error(`Run ${claim.run.id} execution lease is no longer owned`);
  return session;
}

export function getOwnedRunFilter(claim: RunClaim): SQL | undefined {
  return and(
    eq(AGENT_RUNS.id, claim.run.id),
    eq(AGENT_RUNS.ownerToken, claim.ownerToken),
    inArray(AGENT_RUNS.status, ['running', 'cancelling']),
    gt(AGENT_RUNS.leaseUntil, sql`clock_timestamp()`),
  );
}

function getLeaseDeadline() {
  return sql`clock_timestamp() + ${RUN_LEASE_DURATION_MS} * interval '1 millisecond'`;
}

export function parseRun(row: typeof AGENT_RUNS.$inferSelect): AgentRun {
  return AGENT_RUN_SCHEMA.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  });
}

export async function advanceRevision(
  transaction: DatabaseTransaction,
  sessionId: string,
): Promise<void> {
  await transaction
    .update(AGENT_SESSIONS)
    .set({ revision: sql`${AGENT_SESSIONS.revision} + 1` })
    .where(eq(AGENT_SESSIONS.id, sessionId));
}
