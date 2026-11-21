import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { openDatabase } from '../../apps/server/src/infrastructure/database/index.ts';
import {
  consumeWorkInbox,
  createInbox,
  createWorkRouter,
  createWorkRunQueue,
} from '../../apps/server/src/work/index.ts';
import {
  type AccessClient,
  type AccessFixture,
  expectStatus,
  objectField,
  responseBody,
  textField,
  withAccessFixture,
} from './access-fixture.ts';
import { signWebhook } from './webhook-fixture.ts';

const SIGNING_KEY = Buffer.alloc(32, 53);
const SIGNING_SECRET = `whsec_${SIGNING_KEY.toString('base64')}`;
const THREAD = 'review-thread-47';
const TARGET = { kind: 'new_work' };
type Actor = { workspaceId: string; cookie: string };

test('a signed thread event wakes the same Work and resumes its saved progress', testWorkLifecycle);

async function testWorkLifecycle() {
  const connections = new Map<string, string>();
  await withAccessFixture(verifyLifecycle, {
    defaultIsolation: 'repeatable read',
    findWebhookConnection: async (id) => {
      const workspaceId = connections.get(id);
      return workspaceId ? { workspaceId, signingSecret: SIGNING_SECRET } : null;
    },
  });

  async function verifyLifecycle(fixture: AccessFixture) {
    const { db, request, register } = fixture;
    const owner = await register({ email: 'work-owner@example.test', ip: 17 });
    const workspaceId = await createWorkspace(request, owner.cookie);
    const actor = { workspaceId, cookie: owner.cookie };
    const connectionId = randomUUID();
    const unboundId = randomUUID();
    connections.set(connectionId, workspaceId);
    connections.set(unboundId, workspaceId);

    const workId = await verifyAtomicHandoff(fixture, actor);
    await verifyThreadBinding(request, { actor, workId, connectionId });
    await finishInitialRun(fixture, { actor, workId });

    const unknown = await sendWebhook(request, unboundId, randomUUID());
    const next = await sendWebhook(request, connectionId, randomUUID());
    const later = await sendWebhook(request, connectionId, randomUUID());
    await routeEvents(db, [unknown, next, later]);

    const unassigned = await db
      .selectFrom('work_event_decisions')
      .select('disposition')
      .where('event_id', '=', unknown)
      .executeTakeFirstOrThrow();
    assert.equal(unassigned.disposition, 'needs_routing');

    await verifyRunRecovery(fixture, { actor, workId, next, later });
    await verifyExplicitContinuation(fixture, { actor, workId });
    await verifyRevocation(fixture, workspaceId);
  }
}

async function verifyAtomicHandoff({ db, request, databaseUrl }: AccessFixture, actor: Actor) {
  const clientMessageId = randomUUID();
  const message = { clientMessageId, text: 'Track review changes', target: TARGET };
  const eventId = await submit(request, actor, message);
  assert.equal(await submit(request, actor, message), eventId);

  const inbox = createInbox(db);
  const routeEvent = createWorkRouter(db);
  const [delivery] = await inbox.claim();
  assert.equal(delivery?.event.id, eventId);
  assert.ok(delivery);
  const lease = { eventId, token: delivery.token };
  const receiptPath = `/api/work/${actor.workspaceId}/receipts/${eventId}`;

  await checkRollback(databaseUrl, () => routeEvent(lease));

  const pending = await request(receiptPath, { cookie: actor.cookie });
  await expectStatus(pending, 200);
  assert.deepEqual(await pending.json(), { status: 'pending', workId: null });
  assert.deepEqual(await db.selectFrom('work_items').select('id').execute(), []);

  const result = await routeEvent(lease);
  assert.ok(result?.status === 'assigned');
  assert.equal(await routeEvent(lease), null);
  assert.deepEqual(await inbox.claim(), []);

  const assigned = await request(receiptPath, { cookie: actor.cookie });
  await expectStatus(assigned, 200);
  assert.deepEqual(await assigned.json(), result);
  return result.workId;
}

async function checkRollback(databaseUrl: string, routeEvent: () => Promise<unknown>) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      'ALTER TABLE always_on.work_run_requests ADD CONSTRAINT only_for_rollback_test CHECK (false)',
    );
    await assert.rejects(routeEvent, /only_for_rollback_test/);
  } finally {
    try {
      await client.query(
        'ALTER TABLE always_on.work_run_requests DROP CONSTRAINT IF EXISTS only_for_rollback_test',
      );
    } finally {
      await client.end();
    }
  }
}

async function finishInitialRun(
  fixture: AccessFixture,
  { actor, workId }: { actor: Actor; workId: string },
) {
  const runs = createWorkRunQueue(fixture.db);
  assert.equal((await readWork(fixture.request, { actor, workId })).status, 'queued');

  const initial = await runs.claim();
  assert.ok(initial);
  assert.deepEqual(initial.work, { workId, goal: 'Track review changes', progress: null });
  assert.equal((await readWork(fixture.request, { actor, workId })).status, 'running');

  const saved = await runs.complete({
    eventId: initial.event.id,
    token: initial.token,
    progress: 'Review opened',
  });
  assert.equal(saved, true);
  const work = await readWork(fixture.request, { actor, workId });
  assert.equal(work.status, 'waiting');
  assert.equal(work.progress, 'Review opened');
}

async function routeEvents(db: AccessFixture['db'], eventIds: string[]) {
  const controller = new AbortController();
  const errors: unknown[] = [];
  const consuming = consumeWorkInbox({
    inbox: createInbox(db),
    routeEvent: createWorkRouter(db),
    signal: controller.signal,
    reportError: (error) => errors.push(error),
  });

  try {
    await waitForDecisions();
  } finally {
    controller.abort();
    await consuming;
  }
  assert.deepEqual(errors, []);

  async function waitForDecisions() {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const decisions = await db
        .selectFrom('work_event_decisions')
        .select('event_id')
        .where('event_id', 'in', eventIds)
        .execute();
      if (decisions.length === eventIds.length) return;

      await delay(10);
    }
    throw new Error('Work Inbox did not route all thread events');
  }
}

async function verifyRunRecovery(
  { db, databaseUrl, request }: AccessFixture,
  { actor, workId, next, later }: { actor: Actor; workId: string; next: string; later: string },
) {
  const runs = createWorkRunQueue(db);
  const claims = await Promise.all([runs.claim(), runs.claim()]);
  const claimed = claims.filter((claim) => claim !== null);
  assert.equal(claimed.length, 1);
  const [previous] = claimed;
  assert.ok(previous);
  assert.equal(previous.event.id, next);
  assert.equal(previous.work.workId, workId);
  assert.equal(previous.work.progress, 'Review opened');

  await db
    .updateTable('work_run_requests')
    .set({ available_at: new Date(0) })
    .where('event_id', '=', next)
    .execute();
  assert.equal(
    await runs.complete({ eventId: next, token: previous.token, progress: 'Stale' }),
    false,
  );

  const errors: unknown[] = [];
  await using reopened = openDatabase(databaseUrl, (error) => errors.push(error));
  const recovered = createWorkRunQueue(reopened);
  const retry = await recovered.claim();
  assert.ok(retry);
  assert.equal(retry.event.id, next);
  assert.notEqual(retry.token, previous.token);
  assert.equal(
    await recovered.complete({ eventId: next, token: retry.token, progress: 'Review noted' }),
    true,
  );

  const last = await recovered.claim();
  assert.ok(last);
  assert.equal(last.event.id, later);
  assert.equal(last.work.workId, workId);
  assert.equal(last.work.progress, 'Review noted');
  assert.equal(
    await recovered.complete({ eventId: later, token: last.token, progress: 'Changes tracked' }),
    true,
  );

  assert.equal(await recovered.claim(), null);
  assert.equal((await readWork(request, { actor, workId })).status, 'waiting');
  assert.deepEqual(errors, []);
}

async function verifyRevocation({ db, request, register }: AccessFixture, workspaceId: string) {
  const member = await register({ email: 'work-member@example.test', ip: 18 });
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: member.userId, role: 'member' })
    .execute();
  const actor = { workspaceId, cookie: member.cookie };
  const eventIds = await Promise.all([
    submit(request, actor, { clientMessageId: randomUUID(), text: 'Read report', target: TARGET }),
    submit(request, actor, { clientMessageId: randomUUID(), text: 'Check the report status' }),
  ]);
  await db
    .updateTable('workspace_members')
    .set({ role: 'viewer' })
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', member.userId)
    .execute();

  const routeEvent = createWorkRouter(db);
  const claims = await createInbox(db).claim({ limit: eventIds.length });
  assert.deepEqual(claims.map(({ event }) => event.id).sort(), eventIds.sort());
  for (const { event, token } of claims) {
    const decision = await routeEvent({ eventId: event.id, token });
    assert.deepEqual(decision, { status: 'rejected' });
  }
  assert.equal(await createWorkRunQueue(db).claim(), null);
}

async function verifyExplicitContinuation(
  { db, request }: AccessFixture,
  { actor, workId }: { actor: Actor; workId: string },
) {
  const target = { kind: 'existing_work', workId };
  const message = { clientMessageId: randomUUID(), text: 'Check once more', target };
  const foreignId = await createWorkspace(request, actor.cookie);
  const foreign = await submit(request, { ...actor, workspaceId: foreignId }, message);
  const own = await submit(request, actor, message);
  await routeEvents(db, [foreign, own]);

  const receipt = await request(`/api/work/${foreignId}/receipts/${foreign}`, {
    cookie: actor.cookie,
  });
  await expectStatus(receipt, 200);
  assert.deepEqual(await receipt.json(), { status: 'rejected', workId: null });

  const runs = createWorkRunQueue(db);
  const lease = await runs.claim();
  assert.ok(lease);
  assert.equal(lease.event.id, own);
  assert.equal(lease.work.workId, workId);
  assert.equal(lease.work.progress, 'Changes tracked');
  assert.equal(
    await runs.complete({ eventId: own, token: lease.token, progress: 'Checked' }),
    true,
  );
  assert.equal(await runs.claim(), null);
}

async function createWorkspace(request: AccessClient, cookie: string) {
  const response = await request('/api/workspaces', {
    method: 'POST',
    cookie,
    body: { name: 'Work' },
  });
  await expectStatus(response, 201);
  return textField(objectField((await responseBody(response)).workspace).id);
}

async function submit(request: AccessClient, { workspaceId, cookie }: Actor, body: object) {
  const response = await request(`/api/inbox/${workspaceId}/messages`, {
    method: 'POST',
    cookie,
    body,
  });
  await expectStatus(response, 202);
  return textField((await responseBody(response)).eventId);
}

async function readWork(
  request: AccessClient,
  { actor, workId }: { actor: Actor; workId: string },
) {
  const response = await request(`/api/work/${actor.workspaceId}/${workId}`, {
    cookie: actor.cookie,
  });
  await expectStatus(response, 200);
  return objectField((await responseBody(response)).work);
}

async function verifyThreadBinding(
  request: AccessClient,
  { actor, workId, connectionId }: { actor: Actor; workId: string; connectionId: string },
) {
  const path = `/api/work/${actor.workspaceId}/${workId}/threads`;
  for (const conversationId of [THREAD, THREAD, '界'.repeat(800)]) {
    const response = await request(path, {
      method: 'POST',
      cookie: actor.cookie,
      body: { connectionId, conversationId },
    });
    await expectStatus(response, 204);
  }

  const oversized = await request(path, {
    method: 'POST',
    cookie: actor.cookie,
    body: { connectionId, conversationId: '界'.repeat(801) },
  });
  await expectStatus(oversized, 400);
  assert.deepEqual(await oversized.json(), { error: 'invalid_input' });
}

async function sendWebhook(request: AccessClient, connectionId: string, sourceEventId: string) {
  const body = JSON.stringify({
    type: 'review.updated',
    data: { outcome: 'commented' },
    conversationId: THREAD,
  });
  const response = await request(`/api/webhooks/${connectionId}`, {
    method: 'POST',
    body,
    headers: signWebhook({ sourceEventId, body, key: SIGNING_KEY }),
  });
  await expectStatus(response, 202);
  return textField((await responseBody(response)).eventId);
}
