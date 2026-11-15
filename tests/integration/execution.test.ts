import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addAbortListener, once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { promisify } from 'node:util';
import { SESSION_EVENT_SCHEMA, SESSION_SNAPSHOT_SCHEMA } from '@always-on/contracts/agents';
import { and, eq, sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { parseWorkerEnv } from '../../apps/server/src/bootstrap/env.js';
import {
  AGENT_RUNS,
  AUTHENTICATION_TABLES,
  INBOX_EVENTS,
  WORKSPACE_MEMBERS,
} from '../../apps/server/src/infrastructure/database/index.js';
import { claimRun, recoverExpiredRuns, startRunTool } from '../../apps/server/src/tasks/index.js';
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

it.each([
  { sourceEventId: 'invalid-input' },
  { sourceEventId: 'invalid-input', text: '' },
  { sourceEventId: 'invalid-input', text: 'Hello', scopeId: 'forged-scope' },
])('rejects invalid message input before creating durable work: %j', async (body) => {
  await using fixture = await openExecutionFixture();
  const response = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/messages`,
    body,
  });
  expect(response.status).toBe(400);
  const snapshot = await fixture.snapshot();
  expect(snapshot.run).toBeNull();
  expect(snapshot.messages).toEqual([]);
  const events = await fixture.db
    .select()
    .from(INBOX_EVENTS)
    .where(eq(INBOX_EVENTS.scopeId, fixture.sessionId));
  expect(events).toEqual([]);
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

it.each(['message', 'run'] as const)(
  'rejects a foreign Session %s in its real Redis subscription',
  async (type) => {
    await using fixture = await openExecutionFixture();
    await using stream = await fixture.openStream();
    await stream.next('snapshot');
    const sessionId = randomUUID();
    const run = { id: randomUUID(), sessionId, createdAt: new Date().toISOString() };
    const message = {
      id: randomUUID(),
      sessionId,
      runId: run.id,
      role: 'assistant' as const,
      state: 'completed' as const,
      text: 'A different conversation',
      position: 1,
    };

    await fixture.publishEvent(
      type === 'message' ? { type, message } : { type, run: { ...run, status: 'queued' } },
    );
    const unavailable = await stream.next('unavailable');
    expect(unavailable.value).toEqual({ code: 'stream_unavailable' });
    fixture.expectErrors([
      `Session ${fixture.sessionId} stream contains an event from another session`,
    ]);
  },
);

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

it.each(['logout', 'expiration'] as const)(
  'ends an existing stream after login %s',
  async (reason) => {
    await using fixture = await openExecutionFixture();
    await using stream = await fixture.openStream();
    await stream.next('snapshot');
    if (reason === 'logout') {
      expect((await fixture.request({ path: '/api/auth/sign-out' })).status).toBe(200);
    }
    if (reason === 'expiration') {
      await fixture.db
        .update(AUTHENTICATION_TABLES.session)
        .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(AUTHENTICATION_TABLES.session.userId, fixture.userId));
    }
    await stream.next('access_revoked');
  },
);

it('reconciles queued cancellation into an idle subscription without a Worker event', async () => {
  await using fixture = await openExecutionFixture();
  const submitted = await fixture.submit();
  await using stream = await fixture.openStream();
  expect(SESSION_SNAPSHOT_SCHEMA.parse((await stream.next('snapshot')).value).run?.status).toBe(
    'queued',
  );
  const cancelled = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/runs/${submitted.run.id}/cancel`,
  });
  expect(cancelled.status).toBe(200);
  expect(SESSION_SNAPSHOT_SCHEMA.parse((await stream.next('snapshot')).value).run?.status).toBe(
    'cancelled',
  );
});

it('reconciles an expired owner into an idle subscription without replaying the Run', async () => {
  await using fixture = await openExecutionFixture();
  const submitted = await fixture.submit();
  assert.ok(await claimRun({ db: fixture.db, runId: submitted.run.id, ownerToken: randomUUID() }));
  await using stream = await fixture.openStream();
  expect(SESSION_SNAPSHOT_SCHEMA.parse((await stream.next('snapshot')).value).run?.status).toBe(
    'running',
  );
  await fixture.db
    .update(AGENT_RUNS)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(AGENT_RUNS.id, submitted.run.id));
  await recoverExpiredRuns(fixture.db);
  expect(SESSION_SNAPSHOT_SCHEMA.parse((await stream.next('snapshot')).value).run?.status).toBe(
    'recovery_required',
  );
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

it('releases the real Agent Worker after its queue transport disappears', async () => {
  await using fixture = await openExecutionFixture();
  await using relay = await openRedisRelay(parseWorkerEnv(process.env).REDIS_URL);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const errors: Error[] = [];
  await using worker = await fixture.startWorker(execute, {
    redisUrl: relay.url,
    onError: (error) => errors.push(error),
  });

  try {
    await fixture.submit();
    await started.promise;
    // Only the Worker's sockets disappear; fixture HTTP, PG and Redis retain their own connections.
    await relay[Symbol.asyncDispose]();
  } finally {
    release.resolve();
  }

  await expect(worker[Symbol.asyncDispose]()).rejects.toMatchObject({
    message: 'Agent Worker shutdown failed',
    errors: expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('queue did not drain within') }),
    ]),
  });
  expect(errors.length).toBeGreaterThan(0);
  expect((await fixture.snapshot()).run?.status).toBe('cancelled');

  async function execute() {
    started.resolve();
    await release.promise;
    return { status: 'cancelled' as const, checkpoint: null };
  }
});

async function waitForCancellation(signal: AbortSignal) {
  if (signal.aborted) return;

  const completion = Promise.withResolvers<void>();
  using _listener = addAbortListener(signal, () => completion.resolve());
  await completion.promise;
}

async function openRedisRelay(target: string) {
  const targetUrl = new URL(target);
  const sockets = new Set<Socket>();
  const server = createServer(acceptConnection);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const relayUrl = new URL(targetUrl);
  relayUrl.hostname = '127.0.0.1';
  relayUrl.port = String(address.port);
  let closing: Promise<void> | undefined;
  return { url: relayUrl.href, [Symbol.asyncDispose]: dispose };

  function acceptConnection(client: Socket) {
    const upstream = createConnection({
      host: targetUrl.hostname,
      port: Number(targetUrl.port || 6379),
    });
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream).pipe(client);
    // Closing the peer propagates transport errors to the real Redis client under test.
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
  }

  function dispose() {
    closing ??= closeConnections();
    return closing;
  }

  async function closeConnections() {
    const closed = promisify(server.close.bind(server))();
    for (const socket of sockets) socket.destroy();
    await closed;
  }
}
