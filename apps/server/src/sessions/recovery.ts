import type { AgentRun } from '@always-on/contracts/agents';
import { and, eq, sql } from 'drizzle-orm';
import { AGENT_RUNS, type DatabaseTransaction } from '../infrastructure/database/index.js';
import { readSessionAccess, type SessionAccess } from './access.js';
import { advanceSessionRevision, parseRun } from './records.js';

interface ReconcileSessionRun extends SessionAccess {
  readonly runId: string;
  readonly reason: string;
}

/** Records an explicit reconciliation or an expected access or execution-state rejection. */
export type ReconciliationResult =
  | { readonly status: 'reconciled'; readonly run: AgentRun }
  | { readonly status: 'not_found' | 'not_recovering' };

/** Unblocks new input after human review, retaining prior errors and cancelling the old backlog. */
export async function reconcileSessionRun({
  db,
  sessionId,
  userId,
  runId,
  reason,
}: ReconcileSessionRun): Promise<ReconciliationResult> {
  return db.transaction(reconcile);

  async function reconcile(transaction: DatabaseTransaction): Promise<ReconciliationResult> {
    const session = await readSessionAccess({ transaction, sessionId, userId, action: 'manage' });
    if (!session) return { status: 'not_found' };

    const match = and(eq(AGENT_RUNS.sessionId, sessionId), eq(AGENT_RUNS.id, runId));
    const [run] = await transaction.select().from(AGENT_RUNS).where(match);
    if (!run) return { status: 'not_found' };
    if (run.reconciliation) return { status: 'reconciled', run: parseRun(run) };
    if (run.status !== 'recovery_required') return { status: 'not_recovering' };

    const [updated] = await transaction
      .update(AGENT_RUNS)
      .set({
        status: 'failed',
        reconciliation: sql`jsonb_build_object('userId', ${userId}::text, 'reason', ${reason}::text, 'at', clock_timestamp())`,
      })
      .where(match)
      .returning();
    if (!updated) throw new Error(`Run ${runId} disappeared during reconciliation`);

    // Only fresh input can resume execution after a human resolves an uncertain boundary.
    await transaction
      .update(AGENT_RUNS)
      .set({ status: 'cancelled', finishedAt: sql`clock_timestamp()` })
      .where(and(eq(AGENT_RUNS.sessionId, sessionId), eq(AGENT_RUNS.status, 'queued')));
    await advanceSessionRevision(transaction, sessionId);

    return { status: 'reconciled', run: parseRun(updated) };
  }
}
