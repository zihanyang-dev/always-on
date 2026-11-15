import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AGENT_MESSAGE_SCHEMA,
  AGENT_SESSION_SCHEMA,
  SESSION_LIST_PAGE_SCHEMA,
  SESSION_MESSAGE_PAGE_SCHEMA,
  SESSION_PAGE_SIZE,
  SESSION_SNAPSHOT_SCHEMA,
  type SessionHistoryQuery,
} from '@always-on/contracts/agents';
import { eq, sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { createAgent } from '../../apps/server/src/agents/index.js';
import {
  AGENT_MESSAGES,
  AGENT_RUNS,
  AGENT_SESSIONS,
} from '../../apps/server/src/infrastructure/database/index.js';
import { createAgentSession } from '../../apps/server/src/sessions/index.js';
import { claimRun, completeRun, recoverExpiredRuns } from '../../apps/server/src/tasks/index.js';
import { openExecutionFixture, TEST_MODEL_CATALOG } from './execution-fixture.js';
import { openWorkspaceFixture } from './workspace-fixture.js';

type ExecutionFixture = Awaited<ReturnType<typeof openExecutionFixture>>;
type PageSelection = Partial<SessionHistoryQuery>;

it('pages private sessions without skipping timestamp ties or including later insertions', async () => {
  await using fixture = await openExecutionFixture();
  const second = await createConversation(fixture);
  const third = await createConversation(fixture);

  // Adjacent PostgreSQL microseconds collapse to one JavaScript millisecond.
  await fixture.db
    .update(AGENT_SESSIONS)
    .set({ createdAt: sql`'2026-01-01 00:00:00.123456+00'::timestamptz` })
    .where(eq(AGENT_SESSIONS.createdBy, fixture.userId));
  await fixture.db
    .update(AGENT_SESSIONS)
    .set({ createdAt: sql`'2026-01-01 00:00:00.123457+00'::timestamptz` })
    .where(eq(AGENT_SESSIONS.id, third.id));

  const first = await listSessions(fixture, { limit: 1 });
  expect(first.sessions.map((session) => session.id)).toEqual([third.id]);
  const [firstSession] = first.sessions;
  assert.ok(firstSession);
  expect(firstSession.run).toBeNull();
  expect(first.nextCursor).toBe(third.id);
  const inserted = await createConversation(fixture);
  const remaining = [fixture.sessionId, second.id].toSorted().toReversed();
  assert.ok(first.nextCursor);
  const next = await listSessions(fixture, { limit: 1, cursor: first.nextCursor });
  expect(next.sessions.map((session) => session.id)).toEqual(remaining.slice(0, 1));
  assert.ok(next.nextCursor);
  const last = await listSessions(fixture, { limit: 1, cursor: next.nextCursor });
  expect(last.sessions.map((session) => session.id)).toEqual(remaining.slice(1));
  expect(last.nextCursor).toBeNull();
  expect((await listSessions(fixture, { limit: 1 })).sessions.at(0)?.id).toBe(inserted.id);
});

it('keeps conversation discovery and its cursor scoped to the caller and Workspace', async () => {
  await using shared = await openSharedConversations();
  const { fixture, owner, member, workspace, ownerSession, memberSession } = shared;
  const page = await fixture.request({
    actor: owner,
    method: 'GET',
    path: `/api/sessions?workspaceId=${workspace.id}`,
  });
  expect(page.status).toBe(200);
  expect(
    SESSION_LIST_PAGE_SCHEMA.parse(await page.json()).sessions.map((session) => session.id),
  ).toEqual([ownerSession.id]);
  const foreign = await fixture.request({
    actor: owner,
    method: 'GET',
    path: `/api/sessions/${memberSession.id}`,
  });
  expect(foreign.status).toBe(404);
  const secondWorkspace = await fixture.createWorkspace({ actor: owner, label: 'empty' });
  const empty = await fixture.request({
    actor: owner,
    method: 'GET',
    path: `/api/sessions?workspaceId=${secondWorkspace.id}`,
  });
  expect(await empty.json()).toEqual({ sessions: [], nextCursor: null });

  const cursors = [memberSession.id, randomUUID()];
  const invalid = await Promise.all(
    cursors.map((cursor) =>
      fixture.request({
        actor: owner,
        method: 'GET',
        path: `/api/sessions?workspaceId=${workspace.id}&cursor=${cursor}`,
      }),
    ),
  );
  for (const response of invalid) {
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'invalid_cursor' });
  }
  const otherWorkspace = await fixture.request({
    actor: owner,
    method: 'GET',
    path: `/api/sessions?workspaceId=${secondWorkspace.id}&cursor=${ownerSession.id}`,
  });
  expect(otherWorkspace.status).toBe(400);
  const inaccessible = await fixture.request({
    actor: member,
    method: 'GET',
    path: `/api/sessions?workspaceId=${secondWorkspace.id}`,
  });
  expect(inaccessible.status).toBe(404);
});

it('shows an active or recovery blocker ahead of newer queued input in both read views', async () => {
  await using fixture = await openExecutionFixture();
  const first = await fixture.submit({ sourceEventId: 'first' });
  await fixture.submit({ sourceEventId: 'second' });
  const claim = await claimRun({ db: fixture.db, runId: first.run.id, ownerToken: randomUUID() });
  assert.ok(claim);
  expect((await listSessions(fixture)).sessions.at(0)?.run?.id).toBe(first.run.id);
  expect((await fixture.snapshot()).run?.status).toBe('running');

  const cancelled = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/runs/${first.run.id}/cancel`,
  });
  expect(cancelled.status).toBe(200);
  expect((await listSessions(fixture)).sessions.at(0)?.run?.status).toBe('cancelling');
  await fixture.db
    .update(AGENT_RUNS)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(AGENT_RUNS.id, first.run.id));
  await recoverExpiredRuns(fixture.db);
  expect((await listSessions(fixture)).sessions.at(0)?.run?.status).toBe('recovery_required');
  expect((await fixture.snapshot()).run?.id).toBe(first.run.id);
});

it('pages older messages in display order without duplicates when new input arrives', async () => {
  await using fixture = await openExecutionFixture();
  expect(await readHistory(fixture)).toEqual({ messages: [], nextCursor: null });
  const expected = await seedHistory(fixture, SESSION_PAGE_SIZE + 5);
  expect(await readHistory(fixture, { limit: 100 })).toEqual({
    messages: expected,
    nextCursor: null,
  });
  let page = await readHistory(fixture, { limit: 7 });
  expect(page.messages.map((message) => message.id)).toEqual(
    expected.slice(-7).map((message) => message.id),
  );
  const received = [...page.messages];
  await fixture.submit({ sourceEventId: 'later-input', text: 'A new input' });

  while (page.nextCursor) {
    page = await readHistory(fixture, { limit: 7, cursor: page.nextCursor });
    received.push(...page.messages);
  }
  expect(new Set(received.map((message) => message.id)).size).toBe(expected.length);
  const ordered = received.toSorted((first, second) => first.position - second.position);
  expect(ordered).toEqual(expected);
  expect((await readHistory(fixture)).messages.at(-1)?.text).toBe('A new input');
});

it('rejects history cursors from another conversation or cursor kind', async () => {
  await using fixture = await openExecutionFixture();
  const second = await createConversation(fixture);
  const response = await fixture.request({
    path: `/api/sessions/${second.id}/messages`,
    body: { sourceEventId: 'foreign', text: 'A different conversation' },
  });
  expect(response.status).toBe(202);
  const history = await fixture.request({
    path: `/api/sessions/${second.id}/messages`,
    method: 'GET',
  });
  const message = SESSION_MESSAGE_PAGE_SCHEMA.parse(await history.json()).messages.at(0);
  assert.ok(message);
  const cursors = [message.id, fixture.sessionId, randomUUID()];
  const results = await Promise.all(
    cursors.map((cursor) =>
      fixture.request({
        path: `/api/sessions/${fixture.sessionId}/messages?cursor=${cursor}`,
        method: 'GET',
      }),
    ),
  );
  expect(results.map((result) => result.status)).toEqual([400, 400, 400]);
});

it('bounds HTTP and SSE snapshots while keeping older history cursors valid', async () => {
  await using fixture = await openExecutionFixture();
  const messages = await seedHistory(fixture, SESSION_PAGE_SIZE + 5);
  const snapshot = await fixture.snapshot();
  expect(snapshot.messages).toHaveLength(SESSION_PAGE_SIZE);
  expect(snapshot.messages.map((message) => message.id)).toEqual(
    messages.slice(-SESSION_PAGE_SIZE).map((message) => message.id),
  );
  assert.ok(snapshot.nextCursor);
  await using stream = await fixture.openStream('0-1');
  const reset = SESSION_SNAPSHOT_SCHEMA.parse((await stream.next('reset')).value);
  expect(reset.messages).toEqual(snapshot.messages);
  expect(reset.nextCursor).toBe(snapshot.nextCursor);

  await fixture.submit({ sourceEventId: 'newer', text: 'Newer durable input' });
  const updated = SESSION_SNAPSHOT_SCHEMA.parse((await stream.next('snapshot')).value);
  expect(updated.messages).toHaveLength(SESSION_PAGE_SIZE);
  expect(updated.messages.at(-1)?.text).toBe('Newer durable input');
  expect(updated.session.revision).toBeGreaterThan(reset.session.revision);
  const older = await readHistory(fixture, { cursor: snapshot.nextCursor });
  expect(older.messages).toEqual(messages.slice(0, 5));
  expect(older.nextCursor).toBeNull();
});

it('bridges a nonoverlapping reset window through durable history', async () => {
  await using fixture = await openExecutionFixture();
  await seedHistory(fixture, SESSION_PAGE_SIZE + 5);
  const previous = await fixture.snapshot();
  const knownIds = new Set(previous.messages.map((message) => message.id));
  const all = await seedHistory(fixture, SESSION_PAGE_SIZE + 5);

  await using stream = await fixture.openStream('0-1');
  const reset = SESSION_SNAPSHOT_SCHEMA.parse((await stream.next('reset')).value);
  expect(reset.messages.some((message) => knownIds.has(message.id))).toBe(false);
  assert.ok(reset.nextCursor);
  const bridge = await readHistory(fixture, { cursor: reset.nextCursor });
  expect(bridge.messages.some((message) => knownIds.has(message.id))).toBe(true);

  // A reconnect backfill joins the new window without discarding already loaded older messages.
  const messages = [...previous.messages, ...bridge.messages, ...reset.messages];
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const ordered = [...messagesById.values()].toSorted(
    (first, second) => first.position - second.position,
  );
  expect(ordered).toEqual(all.slice(5));
});

it('finds and continues a durable conversation after a real logout and new login', async () => {
  await using shared = await openSharedConversations();
  const { fixture, member, workspace, memberSession } = shared;
  const admitted = await fixture.request({
    actor: member,
    path: `/api/sessions/${memberSession.id}/messages`,
    body: { sourceEventId: 'before-login', text: 'Remember this conversation' },
  });
  expect(admitted.status).toBe(202);
  expect((await fixture.request({ actor: member, path: '/api/auth/sign-out' })).status).toBe(200);
  const loggedOut = await fixture.request({
    actor: member,
    method: 'GET',
    path: `/api/sessions?workspaceId=${workspace.id}`,
  });
  expect(loggedOut.status).toBe(401);
  const signedIn = await fixture.signIn(member);
  const recovered = await fixture.request({
    actor: signedIn,
    method: 'GET',
    path: `/api/sessions?workspaceId=${workspace.id}`,
  });
  const page = SESSION_LIST_PAGE_SCHEMA.parse(await recovered.json());
  expect(page.sessions.map((session) => session.id)).toEqual([memberSession.id]);
  const history = await fixture.request({
    actor: signedIn,
    method: 'GET',
    path: `/api/sessions/${memberSession.id}/messages`,
  });
  expect(SESSION_MESSAGE_PAGE_SCHEMA.parse(await history.json()).messages.at(0)?.text).toBe(
    'Remember this conversation',
  );

  const continued = await fixture.request({
    actor: signedIn,
    path: `/api/sessions/${memberSession.id}/messages`,
    body: { sourceEventId: 'after-login', text: 'Continue after login' },
  });
  expect(continued.status).toBe(202);

  await using _worker = await fixture.startWorker(async (claim, context) => {
    await context.emit({ type: 'message_started', index: 1, role: 'assistant' });
    await context.emit({
      type: 'message',
      index: 1,
      role: 'assistant',
      state: 'completed',
      text: `Continued: ${claim.text}`,
    });
    return { status: 'completed', checkpoint: null };
  });
  // The second Run becomes dispatchable after the first completes and the next one-second scan.
  await vi.waitFor(
    async () => {
      const response = await fixture.request({
        actor: signedIn,
        method: 'GET',
        path: `/api/sessions/${memberSession.id}`,
      });
      const snapshot = SESSION_SNAPSHOT_SCHEMA.parse(await response.json());
      expect(snapshot.run?.status).toBe('completed');
      expect(snapshot.messages.at(-1)?.text).toBe('Continued: Continue after login');
      expect(snapshot.messages).toHaveLength(4);
    },
    { timeout: 5_000 },
  );
});

it('preserves a viewers own history and immediately denies access after membership removal', async () => {
  await using shared = await openSharedConversations();
  const { fixture, owner, member, membership, workspace, memberSession } = shared;
  const admitted = await fixture.request({
    actor: member,
    path: `/api/sessions/${memberSession.id}/messages`,
    body: { sourceEventId: 'before-demotion', text: 'Previous work' },
  });
  expect(admitted.status).toBe(202);
  const demoted = await fixture.request({
    actor: owner,
    path: '/api/auth/organization/update-member-role',
    body: { organizationId: workspace.id, memberId: membership.id, role: 'viewer' },
  });
  expect(demoted.status).toBe(200);
  const paths = [
    `/api/sessions?workspaceId=${workspace.id}`,
    `/api/sessions/${memberSession.id}/messages`,
  ];
  const visible = await Promise.all(
    paths.map((path) => fixture.request({ actor: member, method: 'GET', path })),
  );
  expect(visible.map((response) => response.status)).toEqual([200, 200]);
  const [, history] = visible;
  assert.ok(history);
  expect(SESSION_MESSAGE_PAGE_SCHEMA.parse(await history.json()).messages.at(0)?.text).toBe(
    'Previous work',
  );
  const execution = await fixture.request({
    actor: member,
    path: `/api/sessions/${memberSession.id}/messages`,
    body: { sourceEventId: 'viewer', text: 'Forbidden work' },
  });
  expect(execution.status).toBe(404);

  const removed = await fixture.request({
    actor: owner,
    path: '/api/auth/organization/remove-member',
    body: { organizationId: workspace.id, memberIdOrEmail: member.email },
  });
  expect(removed.status).toBe(200);
  const revoked = await Promise.all(
    paths.map((path) => fixture.request({ actor: member, method: 'GET', path })),
  );
  expect(revoked.map((response) => response.status)).toEqual([404, 404]);
});

it('validates page boundaries before queries and authenticates both read endpoints', async () => {
  await using fixture = await openExecutionFixture();
  const list = `/api/sessions?workspaceId=${fixture.workspaceId}`;
  const history = `/api/sessions/${fixture.sessionId}/messages`;
  const paths = [
    '/api/sessions',
    `${list}&limit=0`,
    `${list}&limit=101`,
    `${list}&limit=1.5`,
    `${history}?limit=0`,
    `${history}?limit=101`,
    `${history}?limit=invalid`,
    `${history}?cursor=invalid`,
    `${list}&createdBy=${fixture.userId}`,
  ];
  const results = await Promise.all(paths.map((path) => fixture.request({ path, method: 'GET' })));
  expect(results.map((response) => response.status)).toEqual(paths.map(() => 400));
  const anonymous = await Promise.all(
    [list, history].map((path) =>
      fixture.request({
        path,
        method: 'GET',
        headers: { cookie: '' },
      }),
    ),
  );
  expect(anonymous.map((response) => response.status)).toEqual([401, 401]);
});

async function listSessions(fixture: ExecutionFixture, selection: PageSelection = {}) {
  const query = createPageQuery(selection);
  query.set('workspaceId', fixture.workspaceId);
  const response = await fixture.request({ path: `/api/sessions?${query}`, method: 'GET' });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const page = SESSION_LIST_PAGE_SCHEMA.parse(body);
  // The wire response must already exclude private fields before the test parser strips them.
  expect(body).toEqual(page);

  return page;
}

async function readHistory(fixture: ExecutionFixture, selection: PageSelection = {}) {
  const query = createPageQuery(selection);
  const response = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/messages?${query}`,
    method: 'GET',
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const page = SESSION_MESSAGE_PAGE_SCHEMA.parse(body);
  expect(body).toEqual(page);

  return page;
}

function createPageQuery({ limit, cursor }: PageSelection) {
  const query = new URLSearchParams();
  if (limit !== undefined) query.set('limit', String(limit));
  if (cursor) query.set('cursor', cursor);

  return query;
}

async function createConversation(fixture: ExecutionFixture) {
  const response = await fixture.request({
    path: '/api/sessions',
    body: { agentId: fixture.agentId },
  });
  expect(response.status).toBe(201);

  return AGENT_SESSION_SCHEMA.parse(await response.json());
}

async function seedHistory(fixture: ExecutionFixture, count: number) {
  const admitted = await fixture.submit({ text: 'message 0' });
  const claim = await claimRun({
    db: fixture.db,
    runId: admitted.run.id,
    ownerToken: randomUUID(),
  });
  assert.ok(claim);
  await fixture.db.insert(AGENT_MESSAGES).values(
    Array.from({ length: count - 1 }, (_, index) => ({
      sessionId: fixture.sessionId,
      runId: admitted.run.id,
      messageIndex: index + 1,
      role: 'assistant' as const,
      state: 'completed' as const,
      text: `message ${index + 1}`,
    })),
  );
  await completeRun({
    db: fixture.db,
    claim,
    completion: { status: 'completed', checkpoint: null },
  });
  const rows = await fixture.db
    .select()
    .from(AGENT_MESSAGES)
    .where(eq(AGENT_MESSAGES.sessionId, fixture.sessionId))
    .orderBy(AGENT_MESSAGES.position);

  return rows.map((row) => AGENT_MESSAGE_SCHEMA.parse(row));
}

async function openSharedConversations() {
  await using startup = new AsyncDisposableStack();
  const fixture = startup.use(await openWorkspaceFixture({ catalog: TEST_MODEL_CATALOG }));
  const [owner, member] = await Promise.all([
    fixture.createActor('owner'),
    fixture.createActor('member'),
  ]);
  const workspace = await fixture.createWorkspace({ actor: owner, label: 'sessions' });
  const membership = await fixture.join({
    actor: owner,
    organizationId: workspace.id,
    recipient: member,
    role: 'member',
  });
  const agent = await createAgent({
    db: fixture.db,
    userId: owner.id,
    input: {
      workspaceId: workspace.id,
      name: 'Shared Agent',
      visibility: 'workspace',
      instructions: 'Help with the request.',
      model: TEST_MODEL_CATALOG.defaultModel,
      reasoningEffort: 'off',
    },
  });
  assert.ok(agent);
  const [ownerSession, memberSession] = await Promise.all(
    [owner, member].map((actor) =>
      createAgentSession({ db: fixture.db, agentId: agent.id, userId: actor.id }),
    ),
  );
  assert.ok(ownerSession && memberSession);
  const resources = startup.move();

  return {
    fixture,
    owner,
    member,
    membership,
    workspace,
    ownerSession,
    memberSession,
    [Symbol.asyncDispose]: resources.disposeAsync.bind(resources),
  };
}
