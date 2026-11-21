import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AGENT_SCHEMA,
  AGENT_SESSION_SCHEMA,
  SESSION_DELETION_SCHEMA,
  SESSION_LIST_PAGE_SCHEMA,
} from '@always-on/contracts/agents';
import { eq, sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import {
  AGENT_RUNS,
  AGENT_SESSIONS,
  AGENT_TOOL_CALLS,
  AGENTS,
  INBOX_EVENTS,
} from '../../apps/server/src/infrastructure/database/index.js';
import {
  processSessionDeletion,
  type SessionResources,
} from '../../apps/server/src/sessions/index.js';
import {
  authorizeRunTool,
  claimRun,
  completeRun,
  recoverExpiredRuns,
  renewRun,
  startRunTool,
} from '../../apps/server/src/tasks/index.js';
import { openExecutionFixture, TEST_MODEL_CATALOG } from './execution-fixture.js';
import { openWorkspaceFixture } from './workspace-fixture.js';

type ExecutionFixture = Awaited<ReturnType<typeof openExecutionFixture>>;

it('records manual reconciliation, preserves tool evidence and cancels the unattended backlog', async () => {
  await using fixture = await openExecutionFixture();
  const active = await fixture.submit();
  const backlog = await fixture.submit({ text: 'Queued before recovery' });
  const claim = await claimRun({ db: fixture.db, runId: active.run.id, ownerToken: randomUUID() });
  assert.ok(claim);
  const toolId = randomUUID();
  await startRunTool({
    db: fixture.db,
    claim,
    tool: { id: toolId, name: 'external_effect' },
  });
  const path = `/api/sessions/${fixture.sessionId}/runs/${active.run.id}/reconcile`;
  const body = { reason: 'Verified the executor stopped and inspected the effect' };
  expect((await fixture.request({ path, body })).status).toBe(409);
  await fixture.db
    .update(AGENT_RUNS)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(AGENT_RUNS.id, active.run.id));
  await recoverExpiredRuns(fixture.db);

  expect((await fixture.request({ path, body, headers: { cookie: '' } })).status).toBe(401);
  const reconciled = await fixture.request({ path, body });
  expect(reconciled.status).toBe(200);
  expect(await reconciled.json()).toMatchObject({ id: active.run.id, status: 'failed' });
  const fresh = await fixture.submit({ text: 'Fresh work after reconciling' });
  const repeated = await fixture.request({ path, body: { reason: 'Duplicate request' } });
  expect(repeated.status).toBe(200);

  const [run, queued, waiting, receipt] = await Promise.all([
    fixture.db.select().from(AGENT_RUNS).where(eq(AGENT_RUNS.id, active.run.id)),
    fixture.db.select().from(AGENT_RUNS).where(eq(AGENT_RUNS.id, fresh.run.id)),
    fixture.db.select().from(AGENT_RUNS).where(eq(AGENT_RUNS.id, backlog.run.id)),
    fixture.db.select().from(AGENT_TOOL_CALLS).where(eq(AGENT_TOOL_CALLS.id, toolId)),
  ]);
  expect(run[0]?.reconciliation).toMatchObject({ userId: fixture.userId, reason: body.reason });
  expect(queued[0]?.status).toBe('queued');
  expect(waiting[0]?.status).toBe('cancelled');
  expect(receipt[0]?.status).toBe('pending');
});

it('lets management schedule cleanup for a former member without opening private history', async () => {
  await using fixture = await openWorkspaceFixture({ catalog: TEST_MODEL_CATALOG });
  const [owner, member, peer] = await Promise.all(
    ['owner', 'member', 'peer'].map((label) => fixture.createActor(label)),
  );
  assert.ok(owner && member && peer);
  const workspace = await fixture.createWorkspace({ actor: owner, label: 'offboarding' });
  const [{ id: membershipId }] = await Promise.all([
    fixture.join({ actor: owner, organizationId: workspace.id, recipient: member, role: 'member' }),
    fixture.join({ actor: owner, organizationId: workspace.id, recipient: peer, role: 'member' }),
  ]);
  const configuration = {
    workspaceId: workspace.id,
    name: 'Offboarding Agent',
    instructions: 'Private instructions',
    model: TEST_MODEL_CATALOG.defaultModel,
    reasoningEffort: 'off',
  };
  const agentId = AGENT_SCHEMA.parse(
    await (
      await fixture.request({ actor: member, path: '/api/agents', body: configuration })
    ).json(),
  ).id;
  const session = AGENT_SESSION_SCHEMA.parse(
    await (
      await fixture.request({ actor: member, path: '/api/sessions', body: { agentId } })
    ).json(),
  );
  const body = { workspaceId: workspace.id, userId: member.id };
  const path = '/api/sessions/offboarding';
  expect((await fixture.request({ actor: owner, path, body })).status).toBe(409);
  expect(
    (
      await fixture.request({
        actor: owner,
        path: '/api/auth/organization/remove-member',
        body: { organizationId: workspace.id, memberIdOrEmail: membershipId },
      })
    ).status,
  ).toBe(200);
  expect((await fixture.request({ actor: peer, path, body })).status).toBe(404);
  expect(
    (
      await fixture.request({
        actor: owner,
        method: 'GET',
        path: `/api/sessions/${session.id}`,
      })
    ).status,
  ).toBe(404);

  const accepted = await fixture.request({ actor: owner, path, body });
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({
    status: 'accepted',
    scheduledSessions: 1,
    remainingSessions: 0,
    deletedPrivateAgents: 0,
  });
  await processSessionDeletion({
    db: fixture.db,
    sessionId: session.id,
    deleteResources: async () => {},
  });
  const repeated = await fixture.request({ actor: owner, path, body });
  expect(await repeated.json()).toEqual({
    status: 'accepted',
    scheduledSessions: 0,
    remainingSessions: 0,
    deletedPrivateAgents: 1,
  });
  expect(
    (
      await fixture.request({
        actor: owner,
        path: '/api/auth/organization/delete',
        body: { organizationId: workspace.id },
      })
    ).status,
  ).toBe(200);
});

it('edits Agent defaults without resetting visibility or changing existing Session and Run snapshots', async () => {
  await using fixture = await openExecutionFixture();
  const previous = (await fixture.snapshot()).session.configuration;
  const admitted = await fixture.submit();
  const updated = await fixture.request({
    path: `/api/agents/${fixture.agentId}`,
    method: 'PATCH',
    body: {
      instructions: 'New defaults',
      visibility: 'workspace',
      model: { provider: 'deepseek', id: 'deepseek-v4-pro' },
      reasoningEffort: 'high',
    },
  });
  expect(updated.status).toBe(200);
  const renamed = await fixture.request({
    path: `/api/agents/${fixture.agentId}`,
    method: 'PATCH',
    body: { name: 'Renamed' },
  });
  const agent = AGENT_SCHEMA.parse(await renamed.json());
  expect(agent.visibility).toBe('workspace');
  expect(agent.instructions).toBe('New defaults');
  expect(agent.reasoningEffort).toBe('high');

  const created = await fixture.request({ path: '/api/sessions', body: { agentId: agent.id } });
  const session = AGENT_SESSION_SCHEMA.parse(await created.json());
  expect(session.configuration).toEqual({
    instructions: agent.instructions,
    model: agent.model,
    reasoningEffort: 'high',
  });
  expect((await fixture.snapshot()).session.configuration).toEqual(previous);
  const [run] = await fixture.db
    .select()
    .from(AGENT_RUNS)
    .where(eq(AGENT_RUNS.id, admitted.run.id));
  expect(run?.configuration).toEqual(previous);
});

it('validates merged model choices while permitting maintenance of unavailable defaults', async () => {
  const catalog = {
    ...TEST_MODEL_CATALOG,
    models: TEST_MODEL_CATALOG.models.map((model) => ({
      ...model,
      reasoningEfforts: model.id === 'deepseek-v4-pro' ? ['high'] : ['off', 'high'],
    })),
  };
  await using fixture = await openExecutionFixture(catalog);
  const invalid = await fixture.request({
    path: `/api/agents/${fixture.agentId}`,
    method: 'PATCH',
    body: { model: { provider: 'deepseek', id: 'deepseek-v4-pro' } },
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ code: 'unsupported_model_configuration' });
  const valid = await fixture.request({
    path: `/api/agents/${fixture.agentId}`,
    method: 'PATCH',
    body: { model: { provider: 'deepseek', id: 'deepseek-v4-pro' }, reasoningEffort: 'high' },
  });
  expect(valid.status).toBe(200);

  // A deployment may remove a model before its owner disables or renames the definition.
  await fixture.db
    .update(AGENTS)
    .set({
      configuration: {
        instructions: 'Old defaults',
        model: { provider: 'removed', id: 'retired' },
        reasoningEffort: 'off',
      },
    })
    .where(eq(AGENTS.id, fixture.agentId));
  const disabled = await fixture.request({
    path: `/api/agents/${fixture.agentId}`,
    method: 'PATCH',
    body: { status: 'disabled' },
  });
  expect(disabled.status).toBe(200);
  expect(AGENT_SCHEMA.parse(await disabled.json()).status).toBe('disabled');
});

it('restricts lifecycle management by current role, visibility and private Session ownership', async () => {
  await using fixture = await openWorkspaceFixture({ catalog: TEST_MODEL_CATALOG });
  const [owner, member, other, viewer] = await Promise.all(
    ['owner', 'member', 'other', 'viewer'].map((label) => fixture.createActor(label)),
  );
  assert.ok(owner && member && other && viewer);
  const workspace = await fixture.createWorkspace({ actor: owner, label: 'lifecycle' });
  const memberships = await Promise.all(
    [member, other, viewer].map((recipient) =>
      fixture.join({ actor: owner, recipient, organizationId: workspace.id, role: 'member' }),
    ),
  );
  const viewerMembership = memberships.at(2);
  assert.ok(viewerMembership);
  const created = await fixture.request({
    actor: member,
    path: '/api/agents',
    body: {
      workspaceId: workspace.id,
      name: 'Member Agent',
      visibility: 'workspace',
      instructions: 'Help.',
      model: TEST_MODEL_CATALOG.defaultModel,
      reasoningEffort: 'off',
    },
  });
  const agent = AGENT_SCHEMA.parse(await created.json());
  const paths = `/api/agents/${agent.id}`;
  const results = await Promise.all([
    fixture.request({ actor: member, path: paths, method: 'PATCH', body: { name: 'Owned' } }),
    fixture.request({ actor: other, path: paths, method: 'PATCH', body: { name: 'Forbidden' } }),
  ]);
  expect(results.map((response) => response.status)).toEqual([200, 404]);
  expect(
    (
      await fixture.request({
        actor: owner,
        path: paths,
        method: 'PATCH',
        body: { name: 'Managed' },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fixture.request({
        actor: member,
        path: paths,
        method: 'PATCH',
        body: { visibility: 'private' },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fixture.request({
        actor: owner,
        path: paths,
        method: 'PATCH',
        body: { name: 'Hidden' },
      })
    ).status,
  ).toBe(404);

  const response = await fixture.request({
    actor: viewer,
    path: '/api/sessions',
    body: { agentId: agent.id },
  });
  expect(response.status).toBe(404);
  await fixture.request({
    actor: member,
    path: paths,
    method: 'PATCH',
    body: { visibility: 'workspace' },
  });
  const conversation = await fixture.request({
    actor: viewer,
    path: '/api/sessions',
    body: { agentId: agent.id },
  });
  const session = AGENT_SESSION_SCHEMA.parse(await conversation.json());
  const demoted = await fixture.request({
    actor: owner,
    path: '/api/auth/organization/update-member-role',
    body: { organizationId: workspace.id, memberId: viewerMembership.id, role: 'viewer' },
  });
  expect(demoted.status).toBe(200);

  const denied = await Promise.all([
    fixture.request({ actor: viewer, path: paths, method: 'PATCH', body: { status: 'disabled' } }),
    fixture.request({
      actor: viewer,
      path: `/api/sessions/${session.id}`,
      method: 'PATCH',
      body: { title: 'Denied' },
    }),
    fixture.request({ actor: viewer, path: `/api/sessions/${session.id}`, method: 'DELETE' }),
    fixture.request({ actor: owner, path: `/api/sessions/${session.id}`, method: 'DELETE' }),
  ]);
  expect(denied.map((result) => result.status)).toEqual([404, 404, 404, 404]);
  expect(
    (await fixture.request({ actor: viewer, path: `/api/sessions/${session.id}`, method: 'GET' }))
      .status,
  ).toBe(200);
});

it('observes Agent disablement during admission, queue claim, live tools and renewal', async () => {
  await using fixture = await openExecutionFixture();
  const first = await fixture.submit({ sourceEventId: 'active' });
  const second = await fixture.submit({ sourceEventId: 'queued' });
  const claim = await claimRun({ db: fixture.db, runId: first.run.id, ownerToken: randomUUID() });
  assert.ok(claim);
  expect(
    (
      await fixture.request({
        path: `/api/agents/${fixture.agentId}`,
        method: 'PATCH',
        body: { status: 'disabled' },
      })
    ).status,
  ).toBe(200);
  const denied = await Promise.all([
    fixture.request({ path: '/api/sessions', body: { agentId: fixture.agentId } }),
    fixture.request({
      path: `/api/sessions/${fixture.sessionId}/messages`,
      body: { sourceEventId: 'new', text: 'Denied' },
    }),
  ]);
  expect(denied.map((response) => response.status)).toEqual([404, 404]);
  expect((await authorizeRunTool({ db: fixture.db, claim })).status).toBe('cancel_requested');
  expect(await renewRun({ db: fixture.db, claim })).toBe('cancel_requested');
  const cancelled = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/runs/${first.run.id}/cancel`,
  });
  expect(cancelled.status).toBe(200);
  expect(
    (
      await completeRun({
        db: fixture.db,
        claim,
        completion: { status: 'completed', checkpoint: null },
      })
    ).status,
  ).toBe('cancelled');
  expect(
    await claimRun({ db: fixture.db, runId: second.run.id, ownerToken: randomUUID() }),
  ).toBeNull();
  expect((await fixture.snapshot()).run?.status).toBe('cancelled');
  expect(
    (
      await fixture.request({
        path: `/api/sessions/${fixture.sessionId}`,
        method: 'PATCH',
        body: { title: 'Retained' },
      })
    ).status,
  ).toBe(200);
});

it('archives without interrupting admitted work and restores only for genuinely new input', async () => {
  await using fixture = await openExecutionFixture();
  const admitted = await fixture.submit({ sourceEventId: 'first' });
  const archived = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}`,
    method: 'PATCH',
    body: { title: 'Project', status: 'archived' },
  });
  expect(archived.status).toBe(200);
  const active = await fixture.request({
    path: `/api/sessions?workspaceId=${fixture.workspaceId}`,
    method: 'GET',
  });
  expect(SESSION_LIST_PAGE_SCHEMA.parse(await active.json()).sessions).toEqual([]);
  const history = await fixture.request({
    path: `/api/sessions?workspaceId=${fixture.workspaceId}&status=archived`,
    method: 'GET',
  });
  expect(SESSION_LIST_PAGE_SCHEMA.parse(await history.json()).sessions.at(0)?.title).toBe(
    'Project',
  );
  expect((await fixture.snapshot()).run?.status).toBe('queued');
  const claim = await claimRun({
    db: fixture.db,
    runId: admitted.run.id,
    ownerToken: randomUUID(),
  });
  assert.ok(claim);
  expect(
    (
      await completeRun({
        db: fixture.db,
        claim,
        completion: { status: 'completed', checkpoint: null },
      })
    ).status,
  ).toBe('completed');

  await fixture.submit({ sourceEventId: 'second', text: 'Resume' });
  expect((await fixture.snapshot()).session.status).toBe('active');
  await fixture.request({
    path: `/api/sessions/${fixture.sessionId}`,
    method: 'PATCH',
    body: { status: 'archived' },
  });
  expect((await fixture.submit({ sourceEventId: 'second', text: 'Resume' })).status).toBe(
    'duplicate',
  );
  expect((await fixture.snapshot()).session.status).toBe('archived');
});

it('retains a referenced Agent and deletes only empty definitions', async () => {
  await using fixture = await openExecutionFixture();
  const occupied = await fixture.request({
    path: `/api/agents/${fixture.agentId}`,
    method: 'DELETE',
  });
  expect(occupied.status).toBe(409);
  expect(await occupied.json()).toEqual({ code: 'has_sessions' });
  await requestDeletion(fixture);
  await processSessionDeletion({
    db: fixture.db,
    sessionId: fixture.sessionId,
    deleteResources: async () => undefined,
  });
  const empty = await fixture.request({ path: `/api/agents/${fixture.agentId}`, method: 'DELETE' });
  expect(empty.status).toBe(204);
  expect(
    (await fixture.request({ path: `/api/agents/${fixture.agentId}`, method: 'DELETE' })).status,
  ).toBe(404);
});

it('durably accepts an idempotent deletion request and immediately revokes existing subscriptions', async () => {
  await using fixture = await openExecutionFixture();
  await using stream = await fixture.openStream();
  await stream.next('snapshot');
  const requested = await requestDeletion(fixture);
  expect(await requestDeletion(fixture)).toEqual(requested);
  const progress = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/deletion`,
    method: 'GET',
  });
  expect(await progress.json()).toEqual(requested);
  const paths = [
    `/api/sessions/${fixture.sessionId}`,
    `/api/sessions/${fixture.sessionId}/messages`,
    `/api/sessions/${fixture.sessionId}/events`,
  ];
  const rejected = await Promise.all(paths.map((path) => fixture.request({ path, method: 'GET' })));
  expect(rejected.map((response) => response.status)).toEqual([404, 404, 404]);
  expect((await stream.next('access_revoked')).value).toEqual({});
  const input = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/messages`,
    body: { sourceEventId: 'after-delete', text: 'Denied' },
  });
  expect(input.status).toBe(404);
});

it('blocks deletion of queued, active, stopping and uncertain execution', async () => {
  await using fixture = await openExecutionFixture();
  const admitted = await fixture.submit();
  await expectDeletionConflict(fixture, 'busy');
  const claim = await claimRun({
    db: fixture.db,
    runId: admitted.run.id,
    ownerToken: randomUUID(),
  });
  assert.ok(claim);
  await expectDeletionConflict(fixture, 'busy');
  await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/runs/${admitted.run.id}/cancel`,
  });
  await expectDeletionConflict(fixture, 'busy');
  await fixture.db
    .update(AGENT_RUNS)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(AGENT_RUNS.id, admitted.run.id));
  await recoverExpiredRuns(fixture.db);
  await expectDeletionConflict(fixture, 'recovery_required');
  expect((await fixture.snapshot()).session.status).toBe('active');
});

it('serializes new input with deletion so only one can be admitted', async () => {
  await using fixture = await openExecutionFixture();
  const [deletion, submission] = await Promise.all([
    fixture.request({ path: `/api/sessions/${fixture.sessionId}`, method: 'DELETE' }),
    fixture.request({
      path: `/api/sessions/${fixture.sessionId}/messages`,
      body: { sourceEventId: 'racing', text: 'Race' },
    }),
  ]);
  expect([
    [202, 404],
    [409, 202],
  ]).toContainEqual([deletion.status, submission.status]);
  const runs = await fixture.db
    .select()
    .from(AGENT_RUNS)
    .where(eq(AGENT_RUNS.sessionId, fixture.sessionId));
  expect(runs).toHaveLength(deletion.status === 202 ? 0 : 1);
});

it('retains cleanup failures with safe progress and retries all resources before removing durable input', async () => {
  await using fixture = await openExecutionFixture();
  const admitted = await fixture.submit();
  const claim = await claimRun({
    db: fixture.db,
    runId: admitted.run.id,
    ownerToken: randomUUID(),
  });
  assert.ok(claim);
  await completeRun({
    db: fixture.db,
    claim,
    completion: { status: 'completed', checkpoint: null },
  });
  await fixture.db
    .update(AGENT_SESSIONS)
    .set({ sandboxId: 'retained-binding' })
    .where(eq(AGENT_SESSIONS.id, fixture.sessionId));
  await requestDeletion(fixture);
  const failure = new Error('Provider diagnostics with credentials');
  const remove = async () => {
    throw failure;
  };
  await expect(
    processSessionDeletion({
      db: fixture.db,
      sessionId: fixture.sessionId,
      deleteResources: remove,
    }),
  ).rejects.toMatchObject({ cause: failure });
  const response = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/deletion`,
    method: 'GET',
  });
  const progress = SESSION_DELETION_SCHEMA.parse(await response.json());
  expect(progress.attempts).toBe(1);
  expect(progress.errorCode).toBe('resource_cleanup_failed');
  const [stored] = await fixture.db
    .select()
    .from(AGENT_SESSIONS)
    .where(eq(AGENT_SESSIONS.id, fixture.sessionId));
  expect(stored?.sandboxId).toBe('retained-binding');

  const released: SessionResources[] = [];
  const deleteResources = async (resources: SessionResources) => {
    released.push(resources);
  };
  await processSessionDeletion({ db: fixture.db, sessionId: fixture.sessionId, deleteResources });
  expect(released).toEqual([]);
  await makeCleanupDue(fixture);
  await processSessionDeletion({ db: fixture.db, sessionId: fixture.sessionId, deleteResources });
  expect(released).toEqual([{ sessionId: fixture.sessionId, sandboxId: 'retained-binding' }]);
  expect(
    await fixture.db.select().from(INBOX_EVENTS).where(eq(INBOX_EVENTS.scopeId, fixture.sessionId)),
  ).toEqual([]);
  expect(
    await fixture.db.select().from(AGENT_RUNS).where(eq(AGENT_RUNS.sessionId, fixture.sessionId)),
  ).toEqual([]);
  await processSessionDeletion({ db: fixture.db, sessionId: fixture.sessionId, deleteResources });
  expect(released).toHaveLength(1);
});

it('safely finishes an expired cleanup attempt even when its old callback later returns', async () => {
  await using fixture = await openExecutionFixture();
  await requestDeletion(fixture);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = processSessionDeletion({
    db: fixture.db,
    sessionId: fixture.sessionId,
    deleteResources: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  try {
    await entered.promise;
    let retries = 0;
    const deleteResources = async () => {
      retries += 1;
    };
    await processSessionDeletion({ db: fixture.db, sessionId: fixture.sessionId, deleteResources });
    expect(retries).toBe(0);
    await makeCleanupDue(fixture);
    await processSessionDeletion({ db: fixture.db, sessionId: fixture.sessionId, deleteResources });
    expect(retries).toBe(1);
  } finally {
    release.resolve();
    await first;
  }
  expect(
    (await fixture.request({ path: `/api/sessions/${fixture.sessionId}/deletion`, method: 'GET' }))
      .status,
  ).toBe(404);
});

it('keeps a newer cleanup attempt intact when the expired attempt later fails', async () => {
  await using fixture = await openExecutionFixture();
  await requestDeletion(fixture);
  const firstEntered = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  const failure = new Error('Expired provider request failed');
  const first = processSessionDeletion({
    db: fixture.db,
    sessionId: fixture.sessionId,
    deleteResources: async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      throw failure;
    },
  });
  const failed = expect(first).rejects.toMatchObject({ cause: failure });
  let second: Promise<void> | undefined;

  try {
    await firstEntered.promise;
    await makeCleanupDue(fixture);
    second = processSessionDeletion({
      db: fixture.db,
      sessionId: fixture.sessionId,
      deleteResources: async () => {
        secondEntered.resolve();
        await releaseSecond.promise;
      },
    });
    await secondEntered.promise;
    const before = await readProgress();
    expect(before.attempts).toBe(2);
    expect(before.errorCode).toBeNull();

    // A late failure must not shorten the live attempt's deadline or replace its progress.
    releaseFirst.resolve();
    await failed;
    expect(await readProgress()).toEqual(before);
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await Promise.all([failed, second]);
  }

  async function readProgress() {
    const response = await fixture.request({
      path: `/api/sessions/${fixture.sessionId}/deletion`,
      method: 'GET',
    });

    return SESSION_DELETION_SCHEMA.parse(await response.json());
  }
});

it('declines resource startup after cancellation wins a database claim wait and leaves work immediately retryable', async () => {
  await using fixture = await openExecutionFixture();
  await requestDeletion(fixture);
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocking = fixture.db.transaction(async (transaction) => {
    await transaction
      .select()
      .from(AGENT_SESSIONS)
      .where(eq(AGENT_SESSIONS.id, fixture.sessionId))
      .for('update');
    locked.resolve();
    await release.promise;
  });
  const controller = new AbortController();
  let removals = 0;
  const deleteResources = async () => {
    removals += 1;
  };
  await locked.promise;
  const pending = processSessionDeletion({
    db: fixture.db,
    sessionId: fixture.sessionId,
    deleteResources,
    signal: controller.signal,
  });
  try {
    controller.abort();
  } finally {
    release.resolve();
    await blocking;
    await pending;
  }
  expect(removals).toBe(0);
  await processSessionDeletion({ db: fixture.db, sessionId: fixture.sessionId, deleteResources });
  expect(removals).toBe(1);
});

it('dispatches persisted deletion after Worker startup and joins cleanup before shutdown completes', async () => {
  await using fixture = await openExecutionFixture();
  await requestDeletion(fixture);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const worker = await fixture.startWorker(
    async () => {
      throw new Error('Deletion must not invoke the harness');
    },
    {
      deleteSessionResources: async () => {
        entered.resolve();
        await release.promise;
      },
    },
  );
  try {
    await entered.promise;
    const closing = worker[Symbol.asyncDispose]();
    release.resolve();
    await closing;
  } finally {
    release.resolve();
    await worker[Symbol.asyncDispose]();
  }
  expect(
    (await fixture.request({ path: `/api/sessions/${fixture.sessionId}/deletion`, method: 'GET' }))
      .status,
  ).toBe(404);
});

it('redispatches a failed cleanup after Worker restart without retaining a failed queue identity', async () => {
  await using fixture = await openExecutionFixture();
  await requestDeletion(fixture);
  const failures: Error[] = [];
  const released = new Set<string>();
  const execute = async () => {
    throw new Error('Cleanup must not invoke a model');
  };

  {
    await using _worker = await fixture.startWorker(execute, {
      onError: (error) => failures.push(error),
      deleteSessionResources: failAfterPartialCleanup,
    });
    await vi.waitFor(
      async () => {
        const response = await fixture.request({
          path: `/api/sessions/${fixture.sessionId}/deletion`,
          method: 'GET',
        });
        expect(SESSION_DELETION_SCHEMA.parse(await response.json()).errorCode).toBe(
          'resource_cleanup_failed',
        );
      },
      { timeout: 5_000 },
    );
  }
  expect(failures.map((error) => error.message)).toEqual([
    `Agent queue job delete-session-${fixture.sessionId} failed`,
  ]);
  await makeCleanupDue(fixture);
  {
    await using _worker = await fixture.startWorker(execute, {
      deleteSessionResources: async (resources) => {
        expect(released.has(resources.sessionId)).toBe(true);
      },
    });
    await vi.waitFor(
      async () => {
        const response = await fixture.request({
          path: `/api/sessions/${fixture.sessionId}/deletion`,
          method: 'GET',
        });
        expect(response.status).toBe(404);
      },
      { timeout: 5_000 },
    );
  }

  async function failAfterPartialCleanup(resources: SessionResources) {
    released.add(resources.sessionId);
    throw new Error('Interrupted after the first external resource was released');
  }
});

it('rejects protected fields, empty patches, unsupported filters and unauthenticated lifecycle requests', async () => {
  await using fixture = await openExecutionFixture();
  const agent = `/api/agents/${fixture.agentId}`;
  const session = `/api/sessions/${fixture.sessionId}`;
  const patches = [
    { path: agent, body: {} },
    { path: agent, body: { workspaceId: 'other' } },
    { path: agent, body: { createdBy: 'other' } },
    { path: agent, body: { status: 'deleting' } },
    { path: session, body: {} },
    { path: session, body: { status: 'deleting' } },
    { path: session, body: { title: ' ' } },
    { path: session, body: { cleanupAfter: 'now' } },
  ];
  const invalid = await Promise.all(
    patches.map((patch) => fixture.request({ ...patch, method: 'PATCH' })),
  );
  expect(invalid.map((response) => response.status)).toEqual(patches.map(() => 400));
  expect(
    (
      await fixture.request({
        path: `/api/sessions?workspaceId=${fixture.workspaceId}&status=deleting`,
        method: 'GET',
      })
    ).status,
  ).toBe(400);
  const anonymous = await Promise.all(
    [agent, session].map((path) =>
      fixture.request({ path, method: 'DELETE', headers: { cookie: '' } }),
    ),
  );
  expect(anonymous.map((response) => response.status)).toEqual([401, 401]);
});

async function requestDeletion(fixture: ExecutionFixture) {
  const response = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}`,
    method: 'DELETE',
  });
  expect(response.status).toBe(202);
  const body: unknown = await response.json();
  const deletion = SESSION_DELETION_SCHEMA.parse(body);
  expect(body).toEqual(deletion);

  return deletion;
}

async function expectDeletionConflict(fixture: ExecutionFixture, code: string) {
  const response = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}`,
    method: 'DELETE',
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code });
}

async function makeCleanupDue(fixture: ExecutionFixture) {
  await fixture.db
    .update(AGENT_SESSIONS)
    .set({ cleanupAfter: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(AGENT_SESSIONS.id, fixture.sessionId));
}
