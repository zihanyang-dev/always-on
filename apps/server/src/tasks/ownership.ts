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

/** Current tool authority; a durable stop request is an expected access outcome. */
export type RunToolAccess = { readonly status: 'allowed' | 'cancel_requested' };

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
  return db.transaction(claim);

  async function claim(transaction: DatabaseTransaction): Promise<RunClaim | null> {
    const [candidate] = await transaction
      .select({ sessionId: AGENT_RUNS.sessionId })
      .from(AGENT_RUNS)
      .where(eq(AGENT_RUNS.id, runId));
    if (!candidate) return null;

    const session = await lockSession(transaction, candidate.sessionId);
    if (!session || session.status === 'deleting') return null;

    // A duplicate wake-up cannot bypass a current owner or an unresolved earlier effect.
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

    // Queue delivery order is advisory; PostgreSQL decides which input may execute next.
    const [next] = await transaction
      .select()
      .from(AGENT_RUNS)
      .where(and(eq(AGENT_RUNS.sessionId, session.id), eq(AGENT_RUNS.status, 'queued')))
      .orderBy(asc(AGENT_RUNS.createdAt), asc(AGENT_RUNS.id))
      .limit(1);
    if (!next || next.id !== runId) return null;

    // Input may have waited in the queue after its submitter lost execution permission.
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
  }
}

/** Renews ownership and observes durable cancellation or permission changes. */
export async function renewRun({
  db,
  claim,
}: {
  db: Database;
  claim: RunClaim;
}): Promise<'active' | 'cancel_requested' | 'lost'> {
  return db.transaction(renew);

  async function renew(
    transaction: DatabaseTransaction,
  ): Promise<'active' | 'cancel_requested' | 'lost'> {
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
    // A cancelling owner stays leased until its SDK and sandbox have finished cleanup.
    const [renewed] = await transaction
      .update(AGENT_RUNS)
      .set({ leaseUntil: getLeaseDeadline(), status: shouldCancel ? 'cancelling' : 'running' })
      .where(getOwnedRunFilter(claim))
      .returning({ id: AGENT_RUNS.id });
    if (!renewed) return 'lost';

    return shouldCancel ? 'cancel_requested' : 'active';
  }
}

/** Finds durable dispatch intents independently of the state of Redis or a previous dispatcher. */
export async function listQueuedRuns(db: Database): Promise<readonly string[]> {
  const blocker = alias(AGENT_RUNS, 'blocking_run');
  const blockingRuns = db
    .select({ id: blocker.id })
    .from(blocker)
    .where(
      and(
        eq(blocker.sessionId, AGENT_RUNS.sessionId),
        inArray(blocker.status, ['running', 'cancelling', 'recovery_required']),
      ),
    );
  const dispatchFilter = and(eq(AGENT_RUNS.status, 'queued'), notExists(blockingRuns));

  const rows = await db
    .selectDistinctOn([AGENT_RUNS.sessionId], { id: AGENT_RUNS.id })
    .from(AGENT_RUNS)
    .where(dispatchFilter)
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
  await Promise.all(candidates.map((candidate) => recoverExpiredRun(db, candidate)));
}

async function recoverExpiredRun(
  db: Database,
  { id, sessionId }: { id: string; sessionId: string },
) {
  return db.transaction(recover);

  async function recover(transaction: DatabaseTransaction) {
    await lockSession(transaction, sessionId);
    // A renewal may have won since the scan; check expiry again under the Session lock.
    const recovered = await transaction
      .update(AGENT_RUNS)
      .set({
        status: 'recovery_required',
        finishedAt: sql`clock_timestamp()`,
        error: `Run ${id} lost its execution owner; inspect native history and tool receipts before continuing`,
      })
      .where(
        and(
          eq(AGENT_RUNS.id, id),
          inArray(AGENT_RUNS.status, ['running', 'cancelling']),
          lt(AGENT_RUNS.leaseUntil, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: AGENT_RUNS.id });
    if (recovered.length === 0) return;

    await transaction
      .update(AGENT_MESSAGES)
      .set({ state: 'interrupted' })
      .where(and(eq(AGENT_MESSAGES.runId, id), eq(AGENT_MESSAGES.state, 'pending')));
    await advanceRevision(transaction, sessionId);
  }
}

async function lockSession(transaction: DatabaseTransaction, sessionId: string) {
  // Execution writes acquire this row before touching Run state, preserving one lock order.
  const [session] = await transaction
    .select()
    .from(AGENT_SESSIONS)
    .where(eq(AGENT_SESSIONS.id, sessionId))
    .for('update');

  return session;
}

/** Locks the Session and checks the live claim before recording an already-observed fact. */
export async function requireOwnership(
  transaction: DatabaseTransaction,
  claim: RunClaim,
): Promise<void> {
  const session = await lockSession(transaction, claim.run.sessionId);
  if (!session) throw new Error(`Run ${claim.run.id} session is unavailable`);

  const [run] = await transaction
    .select({ id: AGENT_RUNS.id })
    .from(AGENT_RUNS)
    .where(getOwnedRunFilter(claim));
  if (!run) throw new Error(`Run ${claim.run.id} execution lease is no longer owned`);
}

/** Reads current permission before checking the lease that authorizes the next action. */
export async function readRunAuthority(
  transaction: DatabaseTransaction,
  claim: RunClaim,
): Promise<RunToolAccess> {
  const session = await lockSession(transaction, claim.run.sessionId);
  if (!session) throw new Error(`Run ${claim.run.id} session is unavailable`);

  const agent = await readUsableAgent({
    transaction,
    agentId: session.agentId,
    userId: claim.userId,
  });
  // Permission locks can wait; only a lease checked after those waits can authorize another tool.
  const [run] = await transaction
    .select({ status: AGENT_RUNS.status })
    .from(AGENT_RUNS)
    .where(getOwnedRunFilter(claim));
  if (!run) throw new Error(`Run ${claim.run.id} execution lease is no longer owned`);

  const shouldCancel = run.status === 'cancelling' || !agent;

  return { status: shouldCancel ? 'cancel_requested' : 'allowed' };
}

/** Fences every write with both owner identity and the database-clock lease deadline. */
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

/** Converts storage timestamps at the durable Run boundary. */
export function parseRun(row: typeof AGENT_RUNS.$inferSelect): AgentRun {
  return AGENT_RUN_SCHEMA.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  });
}

/** Advances the display revision under the caller's existing Session lock. */
export async function advanceRevision(
  transaction: DatabaseTransaction,
  sessionId: string,
): Promise<void> {
  await transaction
    .update(AGENT_SESSIONS)
    .set({ revision: sql`${AGENT_SESSIONS.revision} + 1` })
    .where(eq(AGENT_SESSIONS.id, sessionId));
}
