import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { SESSION_EVENT_SCHEMA, SESSION_SNAPSHOT_SCHEMA } from '@always-on/contracts/agents';
import { and, eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { WORKSPACE_MEMBERS } from '../../apps/server/src/infrastructure/database/index.js';
import { startRunTool } from '../../apps/server/src/tasks/index.js';
import { openExecutionFixture } from './execution-fixture.js';

it('keeps health public and protects Agent endpoints with actual authentication', async () => {
  await using fixture = await openExecutionFixture();
  const health = await fixture.request({
    path: '/api/health/live',
    method: 'GET',
    headers: { cookie: '' },
  });
  expect(health.status).toBe(200);
  const denied = await fixture.request({
    path: '/api/agents/models',
    method: 'GET',
    headers: { cookie: '' },
  });
  expect(denied.status).toBe(401);
  const catalog = await fixture.request({ path: '/api/agents/models', method: 'GET' });
  expect(JSON.stringify(await catalog.json())).not.toContain('apiKey');
});

it('dispatches an input committed before the Worker starts and persists its final message', async () => {
  await using fixture = await openExecutionFixture();
  const submitted = await fixture.submit({ sourceEventId: 'durable-before-start' });
  expect((await fixture.snapshot()).run?.status).toBe('queued');
  await using _worker = await fixture.startWorker(async (_claim, context) => {
    await context.emit({ type: 'message_started', index: 1, role: 'assistant' });
    await context.emit({ type: 'text_delta', index: 1, text: 'fixture answer' });
    await context.emit({
      type: 'message',
      index: 1,
      role: 'assistant',
      state: 'completed',
      text: 'fixture answer',
    });
    return { status: 'completed', checkpoint: null };
  });
  await vi.waitFor(async () => expect((await fixture.snapshot()).run?.status).toBe('completed'), {
    timeout: 5_000,
  });
  expect((await fixture.snapshot()).messages.map((message) => message.text)).toEqual([
    'A durable input',
    'fixture answer',
  ]);
  const repeated = await fixture.submit({ sourceEventId: 'durable-before-start' });
  expect(repeated.status).toBe('duplicate');
  expect(repeated.run.id).toBe(submitted.run.id);
});

it('preserves Session and sandbox ownership when deleting a Workspace with Agents', async () => {
  await using fixture = await openExecutionFixture();
  const response = await fixture.request({
    path: '/api/auth/organization/delete',
    body: { organizationId: fixture.workspaceId },
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'WORKSPACE_HAS_AGENTS' });
  expect((await fixture.snapshot()).session.id).toBe(fixture.sessionId);
});

it('redispatches a durable queued Run after a failed wake-up before ownership was acquired', async () => {
  await using fixture = await openExecutionFixture();
  const submitted = await fixture.submit();
  let claimAttempts = 0;
  await using _worker = await fixture.startWorker(execute, { createId });
  await vi.waitFor(async () => expect((await fixture.snapshot()).run?.status).toBe('completed'), {
    timeout: 5_000,
  });
  expect(claimAttempts).toBe(2);
  fixture.expectErrors([`Agent queue job ${submitted.run.id} failed`]);

  async function execute() {
    return { status: 'completed' as const, checkpoint: null };
  }

  function createId() {
    claimAttempts += 1;
    // An invalid token fails the claim transaction before any executor or external effect runs.
    if (claimAttempts === 1) return 'invalid-owner-token';
    return randomUUID();
  }
});

it('replays retained events and explicitly resets an expired or future cursor', async () => {
  await using fixture = await openExecutionFixture();
  await using _worker = await fixture.startWorker(async (_claim, context) => {
    await context.emit({ type: 'message_started', index: 1, role: 'assistant' });
    await context.emit({
      type: 'message',
      index: 1,
      role: 'assistant',
      state: 'completed',
      text: 'replayed answer',
    });
    return { status: 'completed', checkpoint: null };
  });
  await fixture.submit();
  await vi.waitFor(async () => expect((await fixture.snapshot()).run?.status).toBe('completed'), {
    timeout: 5_000,
  });
  await using stream = await fixture.openStream();
  const initial = await stream.next('snapshot');
  expect(SESSION_SNAPSHOT_SCHEMA.parse(initial.value).run?.status).toBe('completed');
  const first = await stream.next('update');
  expect(SESSION_EVENT_SCHEMA.parse(first.value).type).toBe('run');
  assert.ok(first.id);
  await using replay = await fixture.openStream(first.id);
  await replay.next('snapshot');
  const next = await replay.next('update');
  expect(next.id).not.toBe(first.id);
  await using reset = await fixture.openStream('0-1');
  expect(SESSION_SNAPSHOT_SCHEMA.parse((await reset.next('reset')).value).run?.status).toBe(
    'completed',
  );
  const invalid = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/events`,
    method: 'GET',
    headers: { 'last-event-id': '18446744073709551616-0' },
  });
  expect(invalid.status).toBe(400);
});

it('leaves a Run alive after browser disconnect and cancels only on the explicit endpoint', async () => {
  await using fixture = await openExecutionFixture();
  const started = Promise.withResolvers<AbortSignal>();
  await using _worker = await fixture.startWorker(async (_claim, context) => {
    const signal = context.signal;
    assert.ok(signal);
    started.resolve(signal);
    await waitForCancellation(signal);
    return { status: 'cancelled', checkpoint: null };
  });
  const submitted = await fixture.submit();
  const signal = await started.promise;
  {
    await using stream = await fixture.openStream();
    await stream.next('snapshot');
  }
  expect(signal.aborted).toBe(false);
  const cancelled = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/runs/${submitted.run.id}/cancel`,
  });
  expect(cancelled.status).toBe(200);
  await vi.waitFor(async () => expect((await fixture.snapshot()).run?.status).toBe('cancelled'), {
    timeout: 5_000,
  });
  expect(signal.aborted).toBe(true);
});

it('stops delivering a subscription after current membership is revoked', async () => {
  await using fixture = await openExecutionFixture();
  await using stream = await fixture.openStream();
  await stream.next('snapshot');
  await fixture.db
    .delete(WORKSPACE_MEMBERS)
    .where(
      and(
        eq(WORKSPACE_MEMBERS.organizationId, fixture.workspaceId),
        eq(WORKSPACE_MEMBERS.userId, fixture.userId),
      ),
    );
  await stream.next('access_revoked');
  const denied = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}`,
    method: 'GET',
  });
  expect(denied.status).toBe(404);
});

it('retains an unknown external result and refuses to replay it on a later input', async () => {
  await using fixture = await openExecutionFixture();
  await using _worker = await fixture.startWorker(async (claim) => {
    await startRunTool({
      db: fixture.db,
      claim,
      tool: { id: randomUUID(), name: 'external_effect' },
    });
    throw new Error('Simulated lost tool acknowledgement');
  });
  const submitted = await fixture.submit();
  await vi.waitFor(
    async () => expect((await fixture.snapshot()).run?.status).toBe('recovery_required'),
    { timeout: 5_000 },
  );
  fixture.expectErrors([`Run ${submitted.run.id} execution failed`]);
  const denied = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/messages`,
    body: { sourceEventId: randomUUID(), text: 'Do it again' },
  });
  expect(denied.status).toBe(409);
});

async function waitForCancellation(signal: AbortSignal) {
  if (signal.aborted) return;
  const completion = Promise.withResolvers<void>();
  using _listener = addAbortListener(signal, () => completion.resolve());
  await completion.promise;
}
