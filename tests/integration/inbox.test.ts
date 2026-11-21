import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openDatabase } from '../../apps/server/src/infrastructure/database/index.ts';
import { startObservability } from '../../apps/server/src/infrastructure/index.ts';
import { createInbox, type Inbox, type InboxEvent } from '../../apps/server/src/work/index.ts';
import {
  type AccessClient,
  expectStatus,
  objectField,
  responseBody,
  textField,
  withAccessFixture,
} from './access-fixture.ts';

const SIGNING_KEY = Buffer.alloc(32, 42);
const SECOND_SIGNING_KEY = Buffer.alloc(32, 43);
const TRACE_ID = '0123456789abcdef0123456789abcdef';

type Database = ReturnType<typeof openDatabase>;
type Connections = Map<string, { workspaceId: string; signingSecret: string }>;
type ExpectedEvent = Pick<
  InboxEvent,
  'id' | 'workspaceId' | 'source' | 'conversationId' | 'payload'
>;

test('Inbox persists both origins and recovers leases in PostgreSQL', async () => {
  const connections: Connections = new Map();
  await using observability = startObservability({
    serviceName: 'inbox-test',
    logLevel: 'silent',
    otlpEndpoint: undefined,
  });

  await withAccessFixture(
    async ({ db, databaseUrl, request, register }) => {
      const [owner, viewer] = await Promise.all([
        register({ email: 'inbox-owner@example.test', ip: 8 }),
        register({ email: 'inbox-viewer@example.test', ip: 9 }),
      ]);
      const [first, second] = await Promise.all([
        createWorkspace(request, { cookie: owner.cookie, name: 'First' }),
        createWorkspace(request, { cookie: owner.cookie, name: 'Second' }),
      ]);
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: first, user_id: viewer.userId, role: 'viewer' })
        .execute();

      const sourceEventId = randomUUID();
      const userIds = await verifyUserMessages(request, {
        first,
        second,
        sourceEventId,
        ownerCookie: owner.cookie,
        viewerCookie: viewer.cookie,
      });
      const deliveries = await verifyWebhooks(request, {
        first,
        second,
        sourceEventId,
        connections,
      });

      const inbox = createInbox(db, observability);
      await verifyClaims(inbox, {
        expectedIds: [...userIds, deliveries.webhook.id, deliveries.otherId],
        webhook: deliveries.webhook,
      });

      const submitted = await request(`/api/inbox/${first}/messages`, {
        method: 'POST',
        cookie: owner.cookie,
        body: { clientMessageId: randomUUID(), text: 'Recover me' },
      });
      const { eventId } = await accepted(submitted);
      await verifyLeaseRecovery({ inbox, db, databaseUrl, eventId });
    },
    {
      defaultIsolation: 'repeatable read',
      findWebhookConnection: async (id) => connections.get(id) ?? null,
      observability,
    },
  );
});

async function verifyUserMessages(
  request: AccessClient,
  {
    first,
    second,
    sourceEventId,
    ownerCookie,
    viewerCookie,
  }: {
    first: string;
    second: string;
    sourceEventId: string;
    ownerCookie: string;
    viewerCookie: string;
  },
) {
  const message = { clientMessageId: sourceEventId, text: 'A user message' };
  const submit = (workspaceId: string) =>
    request(`/api/inbox/${workspaceId}/messages`, {
      method: 'POST',
      cookie: ownerCookie,
      body: message,
    });
  const firstAttempts = await Promise.all([submit(first), submit(first)]);
  const [original, repeated] = await Promise.all(firstAttempts.map(accepted));
  assert.ok(original && repeated);
  assert.equal(original.eventId, repeated.eventId);
  assert.deepEqual([original.duplicate, repeated.duplicate].sort(), [false, true]);

  const otherWorkspace = await accepted(await submit(second));
  assert.notEqual(otherWorkspace.eventId, original.eventId);

  const changed = await request(`/api/inbox/${first}/messages`, {
    method: 'POST',
    cookie: ownerCookie,
    body: { ...message, text: 'Edited' },
  });
  await expectStatus(changed, 409);
  assert.deepEqual(await changed.json(), { error: 'event_id_conflict' });

  await expectStatus(
    await request(`/api/inbox/${first}/messages`, {
      method: 'POST',
      cookie: viewerCookie,
      body: message,
    }),
    403,
  );
  await expectStatus(
    await request(`/api/inbox/${second}/messages`, {
      method: 'POST',
      cookie: viewerCookie,
      body: message,
    }),
    404,
  );
  await expectStatus(
    await request(`/api/inbox/${first}/messages`, {
      method: 'POST',
      body: message,
    }),
    401,
  );
  await expectStatus(
    await request(`/api/inbox/${first}/messages`, {
      method: 'POST',
      cookie: ownerCookie,
      body: message,
      origin: 'https://example.test',
    }),
    403,
  );

  return [original.eventId, otherWorkspace.eventId];
}

async function verifyWebhooks(
  request: AccessClient,
  {
    first,
    second,
    sourceEventId,
    connections,
  }: {
    first: string;
    second: string;
    sourceEventId: string;
    connections: Connections;
  },
) {
  const connectionId = randomUUID();
  const otherConnectionId = randomUUID();
  connections.set(connectionId, {
    workspaceId: first,
    signingSecret: `whsec_${SIGNING_KEY.toString('base64')}`,
  });
  connections.set(otherConnectionId, {
    workspaceId: first,
    signingSecret: `whsec_${SECOND_SIGNING_KEY.toString('base64')}`,
  });

  const conversationId = 'thread-42';
  const payload = {
    type: 'issue.updated',
    data: { title: 'New title', number: 12 },
    workspaceId: second,
    conversationId,
  };
  const body = JSON.stringify(payload);
  const send = ({ id = connectionId, rawBody = body }: { id?: string; rawBody?: string } = {}) =>
    request(`/api/webhooks/${id}`, {
      method: 'POST',
      body: rawBody,
      headers: {
        ...signWebhook({
          sourceEventId,
          body: rawBody,
          key: id === otherConnectionId ? SECOND_SIGNING_KEY : SIGNING_KEY,
        }),
        traceparent: `00-${TRACE_ID}-0123456789abcdef-01`,
      },
    });

  const tampered = await request(`/api/webhooks/${connectionId}`, {
    method: 'POST',
    body: `${body} `,
    headers: signWebhook({ sourceEventId, body }),
  });
  await expectStatus(tampered, 401);
  await expectStatus(await send({ id: randomUUID() }), 404);
  await expectStatus(
    await send({ rawBody: '{"type":"issue.updated","data":{"number":1e400}}' }),
    400,
  );
  await expectStatus(
    await send({ rawBody: '{"type":"issue.updated","data":{"title":"bad\\u0000value"}}' }),
    400,
  );

  const webhook = await accepted(await send());
  const redelivery = await accepted(
    await send({
      rawBody: JSON.stringify({ ...payload, data: { number: 12, title: 'New title' } }),
    }),
  );
  assert.deepEqual(redelivery, { eventId: webhook.eventId, duplicate: true });
  await expectStatus(
    await send({ rawBody: JSON.stringify({ ...payload, data: { number: 13 } }) }),
    409,
  );

  const elsewhere = await accepted(await send({ id: otherConnectionId }));
  assert.notEqual(elsewhere.eventId, webhook.eventId);
  const wrongKey = await request(`/api/webhooks/${otherConnectionId}`, {
    method: 'POST',
    body,
    headers: signWebhook({ sourceEventId, body }),
  });
  await expectStatus(wrongKey, 401);

  const expected: ExpectedEvent = {
    id: webhook.eventId,
    workspaceId: first,
    source: { kind: 'channel', id: connectionId, eventId: sourceEventId },
    conversationId,
    payload: payload.data,
  };
  return { webhook: expected, otherId: elsewhere.eventId };
}

async function verifyClaims(
  inbox: Inbox,
  { expectedIds, webhook }: { expectedIds: string[]; webhook: ExpectedEvent },
) {
  const batches = await Promise.all([inbox.claim({ limit: 2 }), inbox.claim({ limit: 2 })]);
  const leases = batches.flat();
  assert.deepEqual(leases.map(({ event }) => event.id).sort(), [...expectedIds].sort());
  assert.ok(leases.every(({ attempt }) => attempt === 1));
  const delivery = leases.find(({ event }) => event.id === webhook.id)?.event;
  assert.ok(delivery);
  assert.equal(delivery.workspaceId, webhook.workspaceId);
  assert.deepEqual(delivery.source, webhook.source);
  assert.equal(delivery.conversationId, webhook.conversationId);
  assert.deepEqual(delivery.payload, webhook.payload);
  assert.ok(delivery.traceParent?.includes(TRACE_ID));

  assert.deepEqual(await inbox.claim(), []);
  await Promise.all(
    leases.map(async ({ event, token }) => {
      assert.equal(await inbox.complete({ eventId: event.id, token }), true);
    }),
  );
}

async function verifyLeaseRecovery({
  inbox,
  db,
  databaseUrl,
  eventId,
}: {
  inbox: Inbox;
  db: Database;
  databaseUrl: string;
  eventId: string;
}) {
  const [lost] = await inbox.claim();
  assert.ok(lost);
  assert.equal(lost.event.id, eventId);

  await db
    .updateTable('inbox_events')
    .set({ available_at: new Date(0) })
    .where('id', '=', eventId)
    .execute();
  assert.equal(await inbox.complete({ eventId, token: lost.token }), false);

  const errors: Error[] = [];
  await using reopened = openDatabase(databaseUrl, (error) => errors.push(error));
  const restartedWorker = createInbox(reopened);
  const [recovered] = await restartedWorker.claim();
  assert.ok(recovered);
  assert.equal(recovered.event.id, eventId);
  assert.equal(recovered.attempt, 2);
  assert.notEqual(recovered.token, lost.token);
  assert.equal(await inbox.retry({ eventId, token: lost.token, delayMs: 0 }), false);
  assert.equal(
    await restartedWorker.retry({ eventId, token: recovered.token, delayMs: 60_000 }),
    true,
  );
  assert.deepEqual(await restartedWorker.claim(), []);
  assert.equal(await restartedWorker.complete({ eventId, token: recovered.token }), false);

  await db
    .updateTable('inbox_events')
    .set({ available_at: new Date(0) })
    .where('id', '=', eventId)
    .execute();
  const [retry] = await restartedWorker.claim();
  assert.ok(retry);
  assert.equal(retry.event.id, eventId);
  assert.equal(retry.attempt, 3);
  assert.equal(await restartedWorker.complete({ eventId, token: retry.token }), true);
  assert.deepEqual(await inbox.claim(), []);
  assert.deepEqual(errors, []);
}

async function createWorkspace(
  request: AccessClient,
  { cookie, name }: { cookie: string; name: string },
) {
  const result = await request('/api/workspaces', { method: 'POST', cookie, body: { name } });
  await expectStatus(result, 201);
  return textField(objectField((await responseBody(result)).workspace).id);
}

async function accepted(response: Response) {
  await expectStatus(response, 202);
  const { eventId, duplicate } = await responseBody(response);
  assert.ok(typeof duplicate === 'boolean');
  return { eventId: textField(eventId), duplicate };
}

function signWebhook({
  sourceEventId,
  body,
  key = SIGNING_KEY,
}: {
  sourceEventId: string;
  body: string;
  key?: Buffer;
}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', key)
    .update(`${sourceEventId}.${timestamp}.${body}`)
    .digest('base64');
  return {
    'webhook-id': sourceEventId,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
  };
}
