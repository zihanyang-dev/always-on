import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AGENT_RUN_SCHEMA,
  AGENT_SCHEMA,
  AGENT_SESSION_SCHEMA,
  SESSION_SNAPSHOT_SCHEMA,
  type SessionEvent,
  type SessionSnapshot,
} from '@always-on/contracts/agents';
import type { ModelCatalog } from '@always-on/contracts/models';
import { expect } from 'vitest';
import { z } from 'zod';
import {
  openWorkspaceFixture,
  type WorkspaceFixture,
  type WorkspaceRequest,
} from './workspace-fixture.js';

const SUBMISSION_SCHEMA = z.object({
  status: z.enum(['accepted', 'duplicate']),
  run: AGENT_RUN_SCHEMA,
});

type ExecutionRequest = Omit<WorkspaceRequest, 'actor'>;
type MessageInput = { readonly text?: string; readonly sourceEventId?: string };
interface SessionStreamFixture extends AsyncDisposable {
  readonly next: (expected: string) => Promise<{ value: unknown; id: string | undefined }>;
}
interface ExecutionFixture extends AsyncDisposable {
  readonly db: WorkspaceFixture['db'];
  readonly userId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly request: (input: ExecutionRequest) => Promise<Response>;
  readonly submit: (input?: MessageInput) => Promise<z.infer<typeof SUBMISSION_SCHEMA>>;
  readonly snapshot: () => Promise<SessionSnapshot>;
  readonly openStream: (cursor?: string) => Promise<SessionStreamFixture>;
  readonly publishEvent: (event: SessionEvent) => Promise<void>;
  readonly startWorker: WorkspaceFixture['startWorker'];
  readonly expectErrors: WorkspaceFixture['expectErrors'];
}

/** Deterministic metadata for tests that inject a harness instead of calling a model provider. */
export const TEST_MODEL_CATALOG = {
  models: [
    {
      provider: 'deepseek',
      id: 'deepseek-flash',
      name: 'Fixture model',
      reasoningEfforts: ['off', 'high'],
    },
    {
      provider: 'deepseek',
      id: 'deepseek-v4-pro',
      name: 'Other fixture model',
      reasoningEfforts: ['off', 'high'],
    },
  ],
  defaultModel: { provider: 'deepseek', id: 'deepseek-flash' },
} satisfies ModelCatalog;

/** Owns real identity, workspace and HTTP resources around a private Agent conversation. */
export async function openExecutionFixture(
  catalog: ModelCatalog = TEST_MODEL_CATALOG,
): Promise<ExecutionFixture> {
  await using startup = new AsyncDisposableStack();
  const fixture = startup.use(await openWorkspaceFixture({ catalog }));
  const actor = await fixture.createActor('runner-owner');
  const workspace = await fixture.createWorkspace({ actor, label: 'execution' });
  const selected = catalog.models.find(
    (model) =>
      model.provider === catalog.defaultModel?.provider && model.id === catalog.defaultModel.id,
  );
  assert.ok(selected);
  const agentResponse = await fixture.request({
    path: '/api/agents',
    actor,
    body: {
      workspaceId: workspace.id,
      name: 'Assistant',
      visibility: 'private',
      instructions: 'Use the provided tools to complete the request. Be brief.',
      model: { provider: selected.provider, id: selected.id },
      reasoningEffort: selected.reasoningEfforts.at(0),
    },
  });
  expect(agentResponse.status).toBe(201);
  const agent = AGENT_SCHEMA.parse(await agentResponse.json());
  const sessionResponse = await fixture.request({
    path: '/api/sessions',
    actor,
    body: { agentId: agent.id },
  });
  expect(sessionResponse.status).toBe(201);
  const session = AGENT_SESSION_SCHEMA.parse(await sessionResponse.json());
  const resources = startup.move();
  return {
    db: fixture.db,
    userId: actor.id,
    workspaceId: workspace.id,
    sessionId: session.id,
    request,
    submit,
    snapshot,
    openStream: (cursor) => openSessionStream({ request, sessionId: session.id, cursor }),
    publishEvent: (event) => fixture.publishEvent({ sessionId: session.id, event }),
    startWorker: fixture.startWorker,
    expectErrors: fixture.expectErrors,
    [Symbol.asyncDispose]: resources.disposeAsync.bind(resources),
  };

  function request(input: ExecutionRequest) {
    return fixture.request({ ...input, actor });
  }

  async function submit({
    text = 'A durable input',
    sourceEventId = randomUUID(),
  }: {
    text?: string;
    sourceEventId?: string;
  } = {}) {
    const response = await request({
      path: `/api/sessions/${session.id}/messages`,
      body: { sourceEventId, text },
    });
    expect([200, 202]).toContain(response.status);
    return SUBMISSION_SCHEMA.parse(await response.json());
  }

  async function snapshot() {
    const response = await request({ path: `/api/sessions/${session.id}`, method: 'GET' });
    expect(response.status).toBe(200);
    return SESSION_SNAPSHOT_SCHEMA.parse(await response.json());
  }
}

async function openSessionStream({
  request,
  sessionId,
  cursor,
}: {
  request: ExecutionFixture['request'];
  sessionId: string;
  cursor: string | undefined;
}): Promise<SessionStreamFixture> {
  const cancellation = new AbortController();
  const response = await request({
    path: `/api/sessions/${sessionId}/events`,
    method: 'GET',
    signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(10_000)]),
    ...(cursor ? { headers: { 'last-event-id': cursor } } : {}),
  });
  expect(response.status).toBe(200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return { next: nextEvent, [Symbol.asyncDispose]: dispose };

  async function nextEvent(expected: string) {
    while (true) {
      const boundary = pending.indexOf('\n\n');
      if (boundary < 0) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`SSE ended before ${expected}`);
        pending += decoder.decode(chunk.value, { stream: true });
        continue;
      }

      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const lines = frame.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
      if (event !== expected) continue;

      const serialized = lines.find((line) => line.startsWith('data: '))?.slice(6);
      if (!serialized) throw new Error(`SSE ${event} has no data`);

      const value: unknown = JSON.parse(serialized);
      return { value, id: lines.find((line) => line.startsWith('id: '))?.slice(4) };
    }
  }

  async function dispose() {
    cancellation.abort();

    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
