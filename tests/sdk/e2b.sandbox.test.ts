import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from 'e2b';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type E2bConnection,
  openE2bWorkspace,
  SandboxNotFoundError,
  type SandboxWorkspace,
} from '../../apps/server/src/sandbox/index.js';

const CONNECTION_SCHEMA = z.object({
  E2B_API_KEY: z.string().min(1),
  E2B_API_URL: z.url().optional(),
  E2B_SANDBOX_URL: z.url().optional(),
});
const environment = CONNECTION_SCHEMA.parse(process.env);
const CONNECTION = {
  apiKey: environment.E2B_API_KEY,
  ...(environment.E2B_API_URL ? { apiUrl: environment.E2B_API_URL } : {}),
  ...(environment.E2B_SANDBOX_URL ? { sandboxUrl: environment.E2B_SANDBOX_URL } : {}),
} satisfies E2bConnection;

let workspace: SandboxWorkspace;

beforeAll(async () => {
  workspace = await openE2bWorkspace({
    connection: CONNECTION,
    binding: { kind: 'new', idempotencyKey: randomUUID() },
  });
});

afterAll(async () => {
  if (!workspace) return;
  try {
    await workspace[Symbol.asyncDispose]();
  } finally {
    // Preserve-on-dispose is application behavior; disposable test VMs must not accumulate.
    await Sandbox.kill(workspace.sandboxId, CONNECTION);
  }
});

it('runs file and command operations in the actual VM', async () => {
  const path = `${workspace.directory}/hello.txt`;
  await workspace.writeFile({ path, content: 'hello from the runner' });
  const [content, command] = await Promise.all([
    workspace.readFile(path),
    runCommand('cat hello.txt'),
  ]);
  expect(content.toString()).toBe('hello from the runner');
  expect(command).toEqual({ exitCode: 0, text: 'hello from the runner' });
});

it('returns a nonzero exit as a command outcome', async () => {
  expect(await runCommand('exit 7')).toEqual({ exitCode: 7, text: '' });
});

it('bounds an untrusted file download before buffering its complete contents', async () => {
  expect((await runCommand('truncate -s 20971521 oversized.bin')).exitCode).toBe(0);
  const [download] = await Promise.allSettled([
    workspace.readFile(`${workspace.directory}/oversized.bin`),
  ]);
  expect(download.status).toBe('rejected');
  assert.ok(download.status === 'rejected');
  assert.ok(download.reason instanceof Error);
  expect(download.reason.message).toContain('exceeds the 20 MiB read limit');
  expect((await runCommand('printf ready')).text).toBe('ready');
});

it('accepts a file at the read limit without truncating its bytes', async () => {
  expect((await runCommand('truncate -s 20971520 read-limit.bin')).exitCode).toBe(0);
  const content = await workspace.readFile(`${workspace.directory}/read-limit.bin`);
  expect(content.byteLength).toBe(20 * 1_024 * 1_024);
  expect(content.at(-1)).toBe(0);
});

it('uploads a file-backed Blob without converting it to an in-memory string', async () => {
  await using resources = new AsyncDisposableStack();
  const directory = await mkdtemp(join(tmpdir(), 'always-on-blob-test-'));
  resources.defer(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'output.txt');
  const text = 'a long command output\n'.repeat(3_000);
  await writeFile(path, text);
  const remotePath = `${workspace.directory}/full-output.txt`;
  await workspace.writeFile({ path: remotePath, content: await openAsBlob(path) });
  expect((await workspace.readFile(remotePath)).toString()).toBe(text);
});

it('keeps Runner model and application credentials out of the VM', async () => {
  const result = await runCommand(
    "env | cut -d= -f1 | grep -E '^(DEEPSEEK_API_KEY|E2B_API_KEY|BETTER_AUTH_SECRET|DATABASE_URL|REDIS_URL)$' || test $? = 1",
  );
  expect(result).toEqual({ exitCode: 0, text: '' });
});

it('acknowledges remote cancellation before allowing the next operation', async () => {
  const controller = new AbortController();
  await expect(
    workspace.executeCommand({
      command: 'echo started; sleep 30; touch cancelled-command-finished',
      directory: workspace.directory,
      signal: controller.signal,
      onOutput: () => controller.abort(),
    }),
  ).rejects.toThrow();
  const result = await runCommand(
    "test ! -f cancelled-command-finished && ! pgrep -f '^sleep 30$'",
  );
  expect(result.exitCode).toBe(0);
});

it('restores the same workspace after an acknowledged pause', async () => {
  const sandboxId = workspace.sandboxId;
  await workspace[Symbol.asyncDispose]();
  workspace = await openE2bWorkspace({
    connection: CONNECTION,
    binding: { kind: 'existing', sandboxId },
  });
  expect(workspace.sandboxId).toBe(sandboxId);
  expect((await workspace.readFile(`${workspace.directory}/hello.txt`)).toString()).toBe(
    'hello from the runner',
  );
});

it('rejects an absent binding instead of replacing the session VM', async () => {
  const sandboxId = workspace.sandboxId;
  await workspace[Symbol.asyncDispose]();
  await Sandbox.kill(sandboxId, CONNECTION);
  await expect(
    openE2bWorkspace({
      connection: CONNECTION,
      binding: { kind: 'existing', sandboxId },
    }),
  ).rejects.toBeInstanceOf(SandboxNotFoundError);
});

async function runCommand(command: string) {
  const chunks: Buffer[] = [];
  const result = await workspace.executeCommand({
    command,
    directory: workspace.directory,
    onOutput: (chunk) => chunks.push(chunk),
  });
  assert.notEqual(result.exitCode, null);
  return { ...result, text: Buffer.concat(chunks).toString() };
}
