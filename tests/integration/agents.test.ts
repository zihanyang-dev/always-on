import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { createAgent, listAgents } from '../../apps/server/src/agents/index.js';
import {
  AGENT_RUNS,
  AGENT_SESSIONS,
  AGENT_TOOL_CALLS,
  AGENTS,
  WORKSPACE_MEMBERS,
} from '../../apps/server/src/infrastructure/database/index.js';
import {
  cancelSessionRun,
  createAgentSession,
  readSessionSnapshot,
  submitSessionMessage,
  updateSessionConfiguration,
} from '../../apps/server/src/sessions/index.js';
import {
  claimRun,
  completeRun,
  createRunWorkspace,
  type RunInterruption,
  recoverExpiredRuns,
  renewRun,
  startRunTool,
  writeRunMessage,
} from '../../apps/server/src/tasks/index.js';
import { openWorkspaceFixture } from './workspace-fixture.js';

const CONFIGURATION = {
  model: { provider: 'deepseek', id: 'deepseek-flash' },
  reasoningEffort: 'off',
  instructions: 'Help with the requested task.',
};

it('keeps private Agents private and gives viewers no execution capability', async () => {
  await using fixture = await openWorkspaceFixture();
  const [owner, viewer] = await Promise.all([
    fixture.createActor('agent-owner'),
    fixture.createActor('agent-viewer'),
  ]);
  const workspace = await fixture.createWorkspace({ actor: owner, label: 'agent-access' });
  await fixture.join({
    actor: owner,
    organizationId: workspace.id,
    recipient: viewer,
    role: 'viewer',
  });
  const agent = await createAgent({
    db: fixture.db,
    userId: owner.id,
    input: { ...CONFIGURATION, workspaceId: workspace.id, name: 'Private', visibility: 'private' },
  });
  assert.ok(agent);
  expect(
    await listAgents({ db: fixture.db, userId: viewer.id, workspaceId: workspace.id }),
  ).toEqual([]);
  expect(
    await createAgentSession({ db: fixture.db, userId: viewer.id, agentId: agent.id }),
  ).toBeNull();
  expect(
    await createAgent({
      db: fixture.db,
      userId: viewer.id,
      input: {
        ...CONFIGURATION,
        workspaceId: workspace.id,
        name: 'Denied',
        visibility: 'workspace',
      },
    }),
  ).toBeNull();
});

it('deduplicates concurrent input and rejects a changed payload with the same identity', async () => {
  await using fixture = await openSessionFixture();
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => fixture.submit('first')));
  expect(outcomes.filter((outcome) => outcome.status === 'accepted')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'duplicate')).toHaveLength(7);
  const changed = await submitSessionMessage({
    db: fixture.db,
    sessionId: fixture.session.id,
    userId: fixture.owner.id,
    input: { sourceEventId: 'first', text: 'different contents' },
  });
  expect(changed.status).toBe('conflict');
  const snapshot = await fixture.snapshot();
  assert.ok(snapshot);
  expect(snapshot.messages).toHaveLength(1);
});

it('snapshots model and reasoning selection at admission', async () => {
  await using fixture = await openSessionFixture();
  const first = await fixture.submit('first');
  assert.ok(first.status === 'accepted');
  const configuration = {
    ...CONFIGURATION,
    model: { provider: 'deepseek', id: 'deepseek-v4-pro' },
    reasoningEffort: 'high',
  };
  await updateSessionConfiguration({
    db: fixture.db,
    sessionId: fixture.session.id,
    userId: fixture.owner.id,
    configuration,
  });
  const second = await fixture.submit('second');
  assert.ok(second.status === 'accepted');
  const rows = await fixture.db
    .select()
    .from(AGENT_RUNS)
    .where(eq(AGENT_RUNS.sessionId, fixture.session.id))
    .orderBy(AGENT_RUNS.createdAt);
  expect(rows.map((row) => row.configuration)).toEqual([CONFIGURATION, configuration]);
});

it('rejects invalid stored configuration before recording another input', async () => {
  await using fixture = await openSessionFixture();
  await fixture.db
    .update(AGENT_SESSIONS)
    .set({ configuration: { invalid: true } })
    .where(eq(AGENT_SESSIONS.id, fixture.session.id));
  await expect(fixture.submit('invalid-configuration')).rejects.toThrow();
  const runs = await fixture.db
    .select({ id: AGENT_RUNS.id })
    .from(AGENT_RUNS)
    .where(eq(AGENT_RUNS.sessionId, fixture.session.id));
  expect(runs).toEqual([]);
});

it('allows one writer and admits the next queued Run only after completion', async () => {
  await using fixture = await openSessionFixture();
  const [first, second] = [await fixture.submit('first'), await fixture.submit('second')];
  assert.ok(first.status === 'accepted' && second.status === 'accepted');
  const claims = await Promise.all(
    Array.from({ length: 6 }, () =>
      claimRun({ db: fixture.db, runId: first.run.id, ownerToken: randomUUID() }),
    ),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(
    await claimRun({ db: fixture.db, runId: second.run.id, ownerToken: randomUUID() }),
  ).toBeNull();
  const claim = claims.find((value) => value !== null);
  assert.ok(claim);
  await completeRun({
    db: fixture.db,
    claim,
    completion: { status: 'completed', checkpoint: null },
  });
  expect(
    await claimRun({ db: fixture.db, runId: second.run.id, ownerToken: randomUUID() }),
  ).not.toBeNull();
});

it('fences an expired writer and quarantines its Session instead of replaying it', async () => {
  await using fixture = await openSessionFixture();
  const claim = await fixture.claim('first');
  await fixture.db
    .update(AGENT_RUNS)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(AGENT_RUNS.id, claim.run.id));
  expect(await renewRun({ db: fixture.db, claim })).toBe('lost');
  await expect(
    writeRunMessage({
      db: fixture.db,
      claim,
      message: { index: 1, role: 'assistant', state: 'completed', text: 'stale result' },
    }),
  ).rejects.toThrow('lease is no longer owned');
  await recoverExpiredRuns(fixture.db);
  expect((await fixture.snapshot())?.run?.status).toBe('recovery_required');
  expect((await fixture.submit('second')).status).toBe('recovery_required');
});

it('preserves unknown tool outcomes even when the SDK reports completion', async () => {
  await using fixture = await openSessionFixture();
  const claim = await fixture.claim('first');
  await startRunTool({ db: fixture.db, claim, tool: { id: randomUUID(), name: 'bash' } });
  await completeRun({
    db: fixture.db,
    claim,
    completion: {
      status: 'completed',
      checkpoint: { executor: 'fixture', reference: 'uncommitted' },
    },
  });
  expect((await fixture.snapshot())?.run?.status).toBe('recovery_required');
  const [stored] = await fixture.db
    .select({ checkpoint: AGENT_SESSIONS.checkpoint })
    .from(AGENT_SESSIONS)
    .where(eq(AGENT_SESSIONS.id, fixture.session.id));
  expect(stored?.checkpoint).toBeNull();
});

it('does not acknowledge a remote write when only its transport was cancelled', async () => {
  await using fixture = await openSessionFixture();
  const claim = await fixture.claim('write-cancellation');
  const transportError = new Error('Upload transport was cancelled');
  const cancellation = new AbortController();
  const interruptions: RunInterruption[] = [];
  const workspace = createRunWorkspace({
    db: fixture.db,
    claim,
    signal: cancellation.signal,
    createId: randomUUID,
    stop: (interruption) => interruptions.push(interruption),
    workspace: {
      directory: '/workspace',
      readFile: async () => Buffer.alloc(0),
      checkFile: async () => {},
      createDirectory: async () => {},
      executeCommand: async () => ({ exitCode: 0 }),
      writeFile: async () => {
        // Aborting an HTTP upload does not confirm that the guest has stopped applying it.
        cancellation.abort(transportError);
        throw transportError;
      },
    },
  });
  await expect(
    workspace.writeFile({ path: '/workspace/proof.txt', content: 'partial' }),
  ).rejects.toBe(transportError);
  const run = await completeRun({
    db: fixture.db,
    claim,
    completion: { status: 'cancelled', checkpoint: null },
  });
  expect(run.status).toBe('recovery_required');
  expect(interruptions.map((interruption) => interruption.kind)).toEqual(['uncertain_effect']);
});

it('observes permission revocation before another side effect starts', async () => {
  await using fixture = await openSessionFixture();
  const claim = await fixture.claim('first');
  await fixture.db
    .update(WORKSPACE_MEMBERS)
    .set({ role: 'viewer' })
    .where(
      and(
        eq(WORKSPACE_MEMBERS.organizationId, fixture.workspace.id),
        eq(WORKSPACE_MEMBERS.userId, fixture.owner.id),
      ),
    );
  expect(await renewRun({ db: fixture.db, claim })).toBe('cancel_requested');
  expect(
    await startRunTool({ db: fixture.db, claim, tool: { id: randomUUID(), name: 'bash' } }),
  ).toEqual({ status: 'cancel_requested' });
});

it('rechecks the execution lease after waiting for an Agent permission lock', async () => {
  await using fixture = await openSessionFixture();
  const claim = await fixture.claim('permission-lock');
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const toolId = randomUUID();
  const locking = fixture.db.transaction(async (transaction) => {
    const [connection] = await transaction
      .select({ pid: sql<number>`pg_backend_pid()` })
      .from(AGENTS)
      .where(eq(AGENTS.id, fixture.session.agentId))
      .for('update');
    assert.ok(connection);
    locked.resolve(connection.pid);
    await release.promise;
    await transaction
      .update(AGENT_RUNS)
      .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(AGENT_RUNS.id, claim.run.id));
  });
  const blockerId = await locked.promise;
  const starting = startRunTool({ db: fixture.db, claim, tool: { id: toolId, name: 'bash' } });

  const [waiting] = await Promise.allSettled([vi.waitFor(assertBlocked)]);
  // Release the lock and join both requests before any assertion can leave fixture-owned work behind.
  release.resolve();
  const [blocker, started] = await Promise.allSettled([locking, starting]);
  expect(waiting.status).toBe('fulfilled');
  expect(blocker.status).toBe('fulfilled');
  assert.ok(started.status === 'rejected');
  expect(started.reason).toMatchObject({
    message: expect.stringContaining('lease is no longer owned'),
  });
  const receipts = await fixture.db
    .select()
    .from(AGENT_TOOL_CALLS)
    .where(eq(AGENT_TOOL_CALLS.id, toolId));
  expect(receipts).toEqual([]);

  async function assertBlocked() {
    const blocked = await fixture.db.execute(sql`
      select pid from pg_stat_activity where ${blockerId} = any(pg_blocking_pids(pid))
    `);
    expect(blocked.rows).toHaveLength(1);
  }
});

it('persists queued cancellation without invoking a Runner', async () => {
  await using fixture = await openSessionFixture();
  const admitted = await fixture.submit('first');
  assert.ok(admitted.status === 'accepted');
  expect(
    (
      await cancelSessionRun({
        db: fixture.db,
        sessionId: fixture.session.id,
        userId: fixture.owner.id,
        runId: admitted.run.id,
      })
    )?.status,
  ).toBe('cancelled');
  expect(
    await claimRun({ db: fixture.db, runId: admitted.run.id, ownerToken: randomUUID() }),
  ).toBeNull();
});

it('keeps a committed cancellation when the model finishes before the next ownership poll', async () => {
  await using fixture = await openSessionFixture();
  const claim = await fixture.claim('cancel-race');
  await cancelSessionRun({
    db: fixture.db,
    sessionId: fixture.session.id,
    userId: fixture.owner.id,
    runId: claim.run.id,
  });
  const completed = await completeRun({
    db: fixture.db,
    claim,
    completion: { status: 'completed', checkpoint: null },
  });
  expect(completed.status).toBe('cancelled');
});

async function openSessionFixture() {
  await using startup = new AsyncDisposableStack();
  const fixture = startup.use(await openWorkspaceFixture());
  const owner = await fixture.createActor('execution-owner');
  const workspace = await fixture.createWorkspace({ actor: owner, label: 'execution' });
  const agent = await createAgent({
    db: fixture.db,
    userId: owner.id,
    input: {
      ...CONFIGURATION,
      workspaceId: workspace.id,
      name: 'Assistant',
      visibility: 'private',
    },
  });
  assert.ok(agent);
  const session = await createAgentSession({ db: fixture.db, userId: owner.id, agentId: agent.id });
  assert.ok(session);
  const sessionId = session.id;
  const resources = startup.move();
  return {
    db: fixture.db,
    owner,
    workspace,
    session,
    submit,
    claim,
    snapshot: () =>
      readSessionSnapshot({ db: fixture.db, sessionId: session.id, userId: owner.id }),
    [Symbol.asyncDispose]: resources.disposeAsync.bind(resources),
  };

  async function submit(sourceEventId: string) {
    return submitSessionMessage({
      db: fixture.db,
      sessionId,
      userId: owner.id,
      input: { sourceEventId, text: 'A test input' },
    });
  }

  async function claim(sourceEventId: string) {
    const admitted = await submit(sourceEventId);
    assert.ok(admitted.status === 'accepted');
    const result = await claimRun({
      db: fixture.db,
      runId: admitted.run.id,
      ownerToken: randomUUID(),
    });
    assert.ok(result);
    return result;
  }
}
