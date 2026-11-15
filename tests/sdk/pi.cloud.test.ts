import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from 'e2b';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { openE2bWorkspace } from '../../apps/server/src/sandbox/index.js';
import type { ExecutionEvent } from '../../packages/agent-runtime/src/execution.js';
import { executePi } from '../../packages/agent-runtime/src/pi/index.js';

const ENVIRONMENT_SCHEMA = z.object({
  DEEPSEEK_API_KEY: z.string().min(1),
  E2B_API_KEY: z.string().min(1),
  E2B_API_URL: z.url().optional(),
  E2B_SANDBOX_URL: z.url().optional(),
});

it('runs Pi outside E2B and resumes its native conversation after the VM is removed', async () => {
  const environment = ENVIRONMENT_SCHEMA.parse(process.env);
  const connection = {
    apiKey: environment.E2B_API_KEY,
    ...(environment.E2B_API_URL ? { apiUrl: environment.E2B_API_URL } : {}),
    ...(environment.E2B_SANDBOX_URL ? { sandboxUrl: environment.E2B_SANDBOX_URL } : {}),
  };
  await using resources = new AsyncDisposableStack();
  const directory = await mkdtemp(join(tmpdir(), 'always-on-cloud-test-'));
  resources.defer(() => rm(directory, { recursive: true, force: true }));
  const workspace = await openE2bWorkspace({
    connection,
    binding: { kind: 'new', idempotencyKey: randomUUID() },
  });
  resources.defer(async () => {
    await Sandbox.kill(workspace.sandboxId, connection);
  });
  const marker = `verified-${randomUUID()}`;
  const events: ExecutionEvent[] = [];
  const modelConnection = { provider: 'deepseek', apiKey: environment.DEEPSEEK_API_KEY };
  const first = await executePi(
    {
      text: `Use bash to run: printf '%s' '${marker}' > hello.txt; cat hello.txt\nReply with the exact file contents.`,
      session: {
        directory: join(directory, 'first-run'),
        connection: modelConnection,
        modelId: 'deepseek-flash',
        reasoningEffort: 'off',
        systemPrompt: 'Complete the requested verification using the provided tools. Be brief.',
        tools: [],
        workspace,
      },
    },
    {
      signal: AbortSignal.timeout(60_000),
      emit: async (event) => {
        events.push(event);
      },
    },
  );
  assert.ok(first.status === 'completed');
  expect(first.text).toContain(marker);
  expect(events).toContainEqual({
    type: 'tool_finished',
    id: expect.any(String),
    name: 'bash',
    isError: false,
  });
  expect((await workspace.readFile(`${workspace.directory}/hello.txt`)).toString()).toBe(marker);
  await expect(access(join(directory, 'first-run', 'hello.txt'))).rejects.toThrow();
  const checkpoint = await readFile(first.checkpoint.sessionFile, 'utf8');

  // Losing execution infrastructure cannot erase the separately owned model conversation.
  await workspace[Symbol.asyncDispose]();
  await Sandbox.kill(workspace.sandboxId, connection);
  const second = await executePi(
    {
      text: 'Without using tools, repeat the exact verification token you read in the previous turn.',
      session: {
        directory: join(directory, 'second-run'),
        connection: modelConnection,
        modelId: 'deepseek-flash',
        reasoningEffort: 'off',
        systemPrompt: 'Complete the requested verification. Be brief.',
        tools: [],
        checkpoint: first.checkpoint,
      },
    },
    { signal: AbortSignal.timeout(60_000), emit: async () => {} },
  );
  assert.ok(second.status === 'completed');
  expect(second.text).toContain(marker);
  expect(await readFile(first.checkpoint.sessionFile, 'utf8')).toBe(checkpoint);
});
