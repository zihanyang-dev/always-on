import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';
import type { ExecutionEvent } from '../../packages/agent-runtime/src/execution.js';
import {
  executePi,
  listPiModels,
  type PiExecutionRequest,
  type PiExecutionResult,
} from '../../packages/agent-runtime/src/pi/index.js';
import type { ExecutionWorkspace } from '../../packages/agent-runtime/src/workspace.js';

const REQUEST_SCHEMA = z.looseObject({
  model: z.string(),
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown() })),
});

it('reads model and reasoning choices from the SDK without exposing credentials', async () => {
  await using fixture = await openModelFixture();
  const { session } = fixture.request('catalogue');
  const models = await listPiModels({
    directory: session.directory,
    connection: session.connection,
  });
  expect(models.length).toBeGreaterThan(0);
  expect(
    models.every((model) => model.provider === 'deepseek' && model.reasoningEfforts.length > 0),
  ).toBe(true);
  expect(JSON.stringify(models)).not.toContain('test-key');
});

it('rejects an unsupported reasoning choice before calling the model', async () => {
  await using fixture = await openModelFixture();
  const request = fixture.request('reason carefully');
  await expect(
    executePi(
      {
        ...request,
        session: { ...request.session, reasoningEffort: 'unsupported-effort' },
      },
      { emit: async () => {} },
    ),
  ).rejects.toThrow('does not support reasoning effort');
  expect(fixture.requests).toHaveLength(0);
});

it('uses the same execution entry for a second provider through a controlled HTTP endpoint', async () => {
  await using fixture = await openModelFixture();
  const request = fixture.request('another provider');
  const { baseUrl } = request.session.connection;
  assert.ok(baseUrl);
  const connection = { provider: 'groq', apiKey: 'test-key', baseUrl };
  const models = await listPiModels({ directory: request.session.directory, connection });
  const selected = models.at(0);
  assert.ok(selected);
  const effort = selected.reasoningEfforts.at(0);
  assert.ok(effort);
  const result = await executePi(
    {
      ...request,
      session: { ...request.session, connection, modelId: selected.id, reasoningEffort: effort },
    },
    { emit: async () => {} },
  );
  expect(result.status).toBe('completed');
  expect(fixture.requests.at(0)?.model).toBe(selected.id);
});

it('rejects an incompatible checkpoint before opening another conversation', async () => {
  await using fixture = await openModelFixture();
  const request = fixture.request('restore incompatible state');
  await expect(
    executePi(
      {
        ...request,
        session: {
          ...request.session,
          checkpoint: { kind: 'another-executor', version: 1, threadId: 'remote-thread' },
        },
      },
      { emit: async () => {} },
    ),
  ).rejects.toThrow();
  expect(fixture.requests).toHaveLength(0);
});

it('joins the native model stream and projects authoritative completed messages', async () => {
  await using fixture = await openModelFixture();
  const events: ExecutionEvent[] = [];
  const result = await executePi(fixture.request('first input'), {
    emit: async (event) => {
      events.push(event);
    },
  });
  assert.ok(result.status === 'completed');
  expect(result.text).toBe('fixture reply');
  const started = events.find(
    (event) => event.type === 'message_started' && event.role === 'assistant',
  );
  assert.ok(started?.type === 'message_started');
  expect(events).toContainEqual({
    type: 'text_delta',
    index: started.index,
    text: 'fixture reply',
  });
  expect(events).toContainEqual({
    type: 'message',
    index: started.index,
    role: 'assistant',
    state: 'completed',
    text: 'fixture reply',
  });
  expect(events.at(-1)).toEqual({ type: 'settled' });
});

it('passes the remote workspace cwd through native Pi tool execution', async () => {
  await using fixture = await openBashFixture('pwd');
  const commands: string[] = [];
  const workspace = {
    directory: '/remote/workspace',
    readFile: rejectUnexpectedOperation,
    checkFile: rejectUnexpectedOperation,
    writeFile: rejectUnexpectedOperation,
    createDirectory: rejectUnexpectedOperation,
    executeCommand: async (input) => {
      expect(input.directory).toBe('/remote/workspace');
      commands.push(input.command);
      input.onOutput(Buffer.from('remote output'));
      return { exitCode: 0 };
    },
  } satisfies ExecutionWorkspace;
  const request = fixture.request('run pwd remotely');
  const result = await executePi(
    { ...request, session: { ...request.session, workspace } },
    { emit: async () => {} },
  );
  expect(result.status).toBe('completed');
  expect(commands).toEqual(['pwd']);

  function rejectUnexpectedOperation(): never {
    throw new Error('Unexpected filesystem operation');
  }
});

it('restores the SDK-owned transcript without replacing it with display messages', async () => {
  await using fixture = await openModelFixture();
  const first = await executePi(fixture.request('first input'), { emit: async () => {} });
  assert.ok(first.status === 'completed');
  const checkpoint = await readFile(first.checkpoint.sessionFile, 'utf8');
  const request = fixture.request('second input');
  const second = await executePi(
    {
      ...request,
      session: { ...request.session, checkpoint: first.checkpoint },
    },
    { emit: async () => {} },
  );
  expect(second.status).toBe('completed');
  expect(await readFile(first.checkpoint.sessionFile, 'utf8')).toBe(checkpoint);
  const messages = fixture.requests.at(1)?.messages;
  assert.ok(messages);
  expect(messages.filter((message) => message.role === 'user')).toMatchObject([
    { content: [{ type: 'text', text: 'first input' }] },
    { content: [{ type: 'text', text: 'second input' }] },
  ]);
  expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
});

it('exports native shell spills into the remote workspace', async () => {
  await using fixture = await openBashFixture('large-output');
  const contents = 'output line\n'.repeat(3_000);
  const files = new Map<string, string>();
  const workspace = {
    directory: '/remote/workspace',
    readFile: async (path: string) => {
      const text = files.get(path);
      if (!text) throw new Error(`Missing fixture file ${path}`);
      return Buffer.from(text);
    },
    checkFile: async () => {},
    writeFile: async (input: Parameters<ExecutionWorkspace['writeFile']>[0]) => {
      files.set(
        input.path,
        typeof input.content === 'string' ? input.content : await input.content.text(),
      );
    },
    createDirectory: async () => {},
    executeCommand: async (input: Parameters<ExecutionWorkspace['executeCommand']>[0]) => {
      input.onOutput(Buffer.from(contents));
      return { exitCode: 0 };
    },
  } satisfies ExecutionWorkspace;
  const request = fixture.request('run a command with long output');
  const result = await executePi(
    { ...request, session: { ...request.session, workspace } },
    { emit: async () => {} },
  );
  expect(result.status).toBe('completed');
  const [remotePath] = files.keys();
  assert.ok(remotePath);
  expect(remotePath.startsWith('/remote/workspace/.agent-outputs/')).toBe(true);
  expect(files.get(remotePath)).toBe(contents);
  const toolMessage = fixture.requests.at(1)?.messages.find((message) => message.role === 'tool');
  expect(JSON.stringify(toolMessage)).toContain(remotePath);
  expect(JSON.stringify(toolMessage)).not.toContain(tmpdir());
});

it('rejects a missing recovery file instead of silently starting another session', async () => {
  await using fixture = await openModelFixture();
  const request = fixture.request('continue');
  await expect(
    executePi(
      {
        ...request,
        session: {
          ...request.session,
          checkpoint: {
            kind: 'pi',
            version: 1,
            sessionFile: join(request.session.directory, 'missing.jsonl'),
          },
        },
      },
      { emit: async () => {} },
    ),
  ).rejects.toThrow('ENOENT');
  expect(fixture.requests).toHaveLength(0);
});

it('applies a newly selected model to the next native conversation turn', async () => {
  await using fixture = await openModelFixture();
  const first = await executePi(fixture.request('first input'), { emit: async () => {} });
  assert.ok(first.status === 'completed');
  const request = fixture.request('continue with another model');
  const second = await executePi(
    {
      ...request,
      session: { ...request.session, modelId: 'deepseek-v4-pro', checkpoint: first.checkpoint },
    },
    { emit: async () => {} },
  );
  expect(second.status).toBe('completed');
  expect(fixture.requests.map((request) => request.model)).toEqual([
    'deepseek-flash',
    'deepseek-v4-pro',
  ]);
});

it('does not invoke the SDK for an input that has already been cancelled', async () => {
  await using fixture = await openModelFixture();
  const result = await executePi(fixture.request('cancelled input'), {
    signal: AbortSignal.abort(),
    emit: async () => {},
  });
  expect(result).toEqual({ status: 'cancelled', checkpoint: null });
  expect(fixture.requests).toHaveLength(0);
});

it('does not start a model request when cancellation arrives during SDK preparation', async () => {
  await using fixture = await openModelFixture();
  const controller = new AbortController();
  const execution = executePi(fixture.request('cancel during startup'), {
    signal: controller.signal,
    emit: async () => {},
  });
  controller.abort();
  expect(await execution).toEqual({ status: 'cancelled', checkpoint: null });
  expect(fixture.requests).toHaveLength(0);
});

it('cancels the native stream and keeps its partial message unfinished', async () => {
  await using fixture = await openModelFixture(startReply);
  const controller = new AbortController();
  const events: ExecutionEvent[] = [];
  const result = await executePi(fixture.request('long response'), {
    signal: controller.signal,
    emit: async (event) => {
      events.push(event);
      if (event.type === 'text_delta') controller.abort();
    },
  });
  expect(result.status).toBe('cancelled');
  expect(
    events.some(
      (event) =>
        event.type === 'message' && event.role === 'assistant' && event.state === 'completed',
    ),
  ).toBe(false);
});

it('retains failed event acknowledgement even if SDK cancellation follows it', async () => {
  await using fixture = await openModelFixture();
  const failure = new Error('Database refused message acknowledgement');
  const execution = executePi(fixture.request('persist this'), {
    emit: async (event) => {
      if (event.type === 'text_delta') throw failure;
    },
  });
  await expect(execution).rejects.toMatchObject({ cause: failure });
});

it('does not report completion before the receiver acknowledges the final event', async () => {
  await using fixture = await openModelFixture();
  const accepting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const execution = executePi(fixture.request('wait for acceptance'), {
    emit: async (event) => {
      if (event.type !== 'settled') return;
      accepting.resolve();
      await release.promise;
    },
  });
  await accepting.promise;
  let hasCompleted = false;
  const observed = observeCompletion();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hasCompleted).toBe(false);
  } finally {
    release.resolve();
  }
  expect((await observed).status).toBe('completed');

  async function observeCompletion(): Promise<PiExecutionResult> {
    const result = await execution;
    hasCompleted = true;
    return result;
  }
});

async function openModelFixture(respond: (response: ServerResponse) => void = finishReply) {
  await using startup = new AsyncDisposableStack();
  const directory = await mkdtemp(join(tmpdir(), 'always-on-pi-test-'));
  startup.defer(() => rm(directory, { recursive: true, force: true }));
  const requests: z.infer<typeof REQUEST_SCHEMA>[] = [];
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  startup.defer(closeServer);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const resources = startup.move();
  return {
    requests,
    request: createRequest,
    [Symbol.asyncDispose]: resources.disposeAsync.bind(resources),
  };

  function createRequest(text: string): PiExecutionRequest {
    return {
      text,
      session: {
        directory,
        connection: { provider: 'deepseek', apiKey: 'test-key', baseUrl },
        modelId: 'deepseek-flash',
        reasoningEffort: 'off',
        systemPrompt: 'Follow the user request.',
        tools: [],
      },
    };
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Unexpected model request chunk');
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(REQUEST_SCHEMA.parse(body));
      respond(response);
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  }

  async function closeServer() {
    server.closeAllConnections();
    await promisify(server.close.bind(server))();
    expect(failures).toEqual([]);
  }
}

function startReply(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  writeChunk(response, { role: 'assistant', content: 'fixture reply' }, null);
}

function finishReply(response: ServerResponse) {
  startReply(response);
  writeChunk(response, {}, 'stop');
  response.end('data: [DONE]\n\n');
}

function writeChunk(
  response: ServerResponse,
  delta: Record<string, unknown>,
  finishReason: 'stop' | 'tool_calls' | null,
) {
  const chunk = {
    id: 'completion-fixture',
    object: 'chat.completion.chunk',
    model: 'deepseek-flash',
    created: 0,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function openBashFixture(command: string) {
  let didRequestTool = false;

  return openModelFixture(respondToRequest);

  function respondToRequest(response: ServerResponse) {
    if (didRequestTool) return finishReply(response);

    didRequestTool = true;
    const toolCall = {
      index: 0,
      id: 'remote-command',
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command }) },
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    writeChunk(response, { role: 'assistant', tool_calls: [toolCall] }, 'tool_calls');
    response.end('data: [DONE]\n\n');
  }
}
