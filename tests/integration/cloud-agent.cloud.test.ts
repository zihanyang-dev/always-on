import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_EVENT_SCHEMA } from '@always-on/contracts/agents';
import { eq } from 'drizzle-orm';
import { Sandbox, SandboxNotFoundError } from 'e2b';
import { expect, it, vi } from 'vitest';
import {
  deleteCloudSessionResources,
  executeCloudRun,
  loadAgentModelCatalog,
} from '../../apps/server/src/bootstrap/cloud-agent.js';
import { parseWorkerEnv } from '../../apps/server/src/bootstrap/env.js';
import {
  AGENT_SESSIONS,
  AGENT_TOOL_CALLS,
} from '../../apps/server/src/infrastructure/database/index.js';
import { getRunDirectory } from '../../apps/server/src/infrastructure/session-storage/index.js';
import { openE2bWorkspace } from '../../apps/server/src/sandbox/index.js';
import type { RunExecutor } from '../../apps/server/src/tasks/index.js';
import { openExecutionFixture } from './execution-fixture.js';

it('deletes a paused E2B binding and every owned attempt through the real deletion Worker', async () => {
  const environment = parseWorkerEnv(process.env);
  assert.ok(environment.cloudAgent);
  await using resources = new AsyncDisposableStack();
  const directory = await mkdtemp(join(tmpdir(), 'always-on-cloud-deletion-'));
  resources.defer(() => rm(directory, { recursive: true, force: true }));
  const config = { ...environment.cloudAgent, directory };
  const fixture = resources.use(await openExecutionFixture());
  const sandbox = await openE2bWorkspace({
    connection: config.sandbox,
    binding: {
      kind: 'new',
      idempotencyKey: fixture.sessionId,
      metadata: {
        application: 'always-on',
        sessionId: fixture.sessionId,
        workspaceId: fixture.workspaceId,
      },
    },
  });
  const sandboxId = sandbox.sandboxId;
  resources.defer(removeSandbox);
  await sandbox[Symbol.asyncDispose]();
  expect((await Sandbox.getInfo(sandboxId, config.sandbox)).state).toBe('paused');
  await fixture.db
    .update(AGENT_SESSIONS)
    .set({ sandboxId })
    .where(eq(AGENT_SESSIONS.id, fixture.sessionId));

  const first = getRunDirectory({
    directory,
    sessionId: fixture.sessionId,
    runId: randomUUID(),
    ownerToken: randomUUID(),
  });
  const second = getRunDirectory({
    directory,
    sessionId: fixture.sessionId,
    runId: randomUUID(),
    ownerToken: randomUUID(),
  });
  const other = getRunDirectory({
    directory,
    sessionId: randomUUID(),
    runId: randomUUID(),
    ownerToken: randomUUID(),
  });
  const attempts = [first, second, other];
  await Promise.all(attempts.map((path) => mkdir(path, { recursive: true })));
  await Promise.all(
    attempts.map((path) => writeFile(join(path, 'session.jsonl'), 'Opaque SDK bytes')),
  );
  expect(
    (await fixture.request({ path: `/api/sessions/${fixture.sessionId}`, method: 'DELETE' }))
      .status,
  ).toBe(202);

  await using _worker = await fixture.startWorker(
    async () => {
      throw new Error('Deletion must not run a model');
    },
    {
      deleteSessionResources: (identities) =>
        deleteCloudSessionResources({ config, ...identities }),
    },
  );
  await vi.waitFor(
    async () => {
      const progress = await fixture.request({
        path: `/api/sessions/${fixture.sessionId}/deletion`,
        method: 'GET',
      });
      expect(progress.status).toBe(404);
    },
    { timeout: 10_000 },
  );

  await expect(Sandbox.getInfo(sandboxId, config.sandbox)).rejects.toBeInstanceOf(
    SandboxNotFoundError,
  );
  await expect(readFile(join(first, 'session.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(second, 'session.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(other, 'session.jsonl'), 'utf8')).toBe('Opaque SDK bytes');
  await deleteCloudSessionResources({ config, sessionId: fixture.sessionId, sandboxId });

  async function removeSandbox() {
    await Sandbox.kill(sandboxId, config.sandbox);
  }
});

it('executes and resumes the real HTTP, queue, Pi, DeepSeek and E2B chain', async () => {
  const environment = parseWorkerEnv(process.env);
  assert.ok(
    environment.cloudAgent,
    'Configure DeepSeek, E2B and Agent state storage for the cloud test',
  );
  await using resources = new AsyncDisposableStack();
  const directory = await mkdtemp(join(tmpdir(), 'always-on-backend-cloud-'));
  resources.defer(() => rm(directory, { recursive: true, force: true }));
  const config = { ...environment.cloudAgent, directory };
  const catalog = await loadAgentModelCatalog(config);
  const fixture = resources.use(await openExecutionFixture(catalog));
  resources.defer(removeSandbox);
  const failures: Error[] = [];
  const execute: RunExecutor = (claim, context) =>
    executeCloudRun({
      db: fixture.db,
      config,
      claim,
      context,
      createId: randomUUID,
      onError: (error) => failures.push(error),
    });
  const marker = `backend-${randomUUID()}`;
  let firstCheckpoint: unknown;

  {
    await using _worker = await fixture.startWorker(execute);
    const submitted = await fixture.submit({
      text: `First call get_workspace_context. Then use bash to run: printf '%s' '${marker}' > proof.txt; cat proof.txt\nReply with the exact file contents.`,
    });
    await waitForStatus('completed');
    const snapshot = await fixture.snapshot();
    expect(
      snapshot.messages.some(
        (message) => message.role === 'assistant' && message.text.includes(marker),
      ),
    ).toBe(true);
    expect(
      snapshot.messages.some(
        (message) => message.role === 'tool' && message.text.includes(fixture.workspaceId),
      ),
    ).toBe(true);
    const receipts = await fixture.db
      .select()
      .from(AGENT_TOOL_CALLS)
      .where(eq(AGENT_TOOL_CALLS.runId, submitted.run.id));
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.every((receipt) => receipt.status === 'completed')).toBe(true);
    const stored = await readStoredSession();
    assert.ok(stored.checkpoint && stored.sandboxId);
    firstCheckpoint = structuredClone(stored.checkpoint);
    await using stream = await fixture.openStream();
    await stream.next('snapshot');
    const toolNames = new Set<string>();
    while (true) {
      const event = SESSION_EVENT_SCHEMA.parse((await stream.next('update')).value);
      if (event.type === 'tool') toolNames.add(event.name);
      if (
        event.type === 'run' &&
        event.run.id === submitted.run.id &&
        event.run.status === 'completed'
      )
        break;
    }
    expect(toolNames.has('get_workspace_context')).toBe(true);
    expect(toolNames.has('bash')).toBe(true);
  }

  const model = catalog.models.find(
    (option) => option.provider === 'deepseek' && option.id === 'deepseek-v4-pro',
  );
  assert.ok(model);
  expect(model.reasoningEfforts).toContain('high');
  const changed = await fixture.request({
    path: `/api/sessions/${fixture.sessionId}/configuration`,
    method: 'PATCH',
    body: {
      instructions: 'Use the provided tools when asked. Be brief.',
      model: { provider: model.provider, id: model.id },
      reasoningEffort: 'high',
    },
  });
  expect(changed.status).toBe(200);
  await changed.json();
  const initialBinding = (await readStoredSession()).sandboxId;
  {
    // A new Worker must recover both the independently stored SDK conversation and the paused VM.
    await using _worker = await fixture.startWorker(execute);
    await fixture.submit({
      text: 'Use the read tool to read proof.txt. Reply only with the exact token from the file.',
    });
    await waitForStatus('completed');
    expect((await fixture.snapshot()).messages.at(-1)?.text).toContain(marker);
    expect((await readStoredSession()).sandboxId).toBe(initialBinding);
    expect((await readStoredSession()).checkpoint).not.toEqual(firstCheckpoint);
  }

  assert.ok(initialBinding);
  await Sandbox.kill(initialBinding, config.sandbox);
  {
    await using _worker = await fixture.startWorker(execute);
    await fixture.submit({ text: 'Use the read tool to read proof.txt now.' });
    await waitForStatus('failed');
    expect((await readStoredSession()).sandboxId).toBe(initialBinding);
    await fixture.submit({
      text: 'Without using any tools, repeat the exact token from our earlier successful verification.',
    });
    await waitForStatus('completed');
    expect((await fixture.snapshot()).messages.at(-1)?.text).toContain(marker);
  }
  expect(failures.map((error) => error.message)).toEqual([]);

  async function waitForStatus(status: string) {
    await vi.waitFor(async () => expect((await fixture.snapshot()).run?.status).toBe(status), {
      timeout: 90_000,
      interval: 100,
    });
  }

  async function readStoredSession() {
    const [session] = await fixture.db
      .select()
      .from(AGENT_SESSIONS)
      .where(eq(AGENT_SESSIONS.id, fixture.sessionId));
    assert.ok(session);
    return session;
  }

  async function removeSandbox() {
    const { sandboxId } = await readStoredSession();
    if (sandboxId) await Sandbox.kill(sandboxId, config.sandbox);
  }
});
