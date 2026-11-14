import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, it } from 'vitest';
import { discoverLocalAgents } from './index.js';

it('finds executable CLIs while ignoring directories and non-executable files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'always-on-agents-'));
  try {
    await writeFile(join(directory, 'codex'), '#!/bin/sh\nexit 0\n');
    await chmod(join(directory, 'codex'), 0o755);
    await mkdir(join(directory, 'claude'));
    await writeFile(join(directory, 'pi'), 'not executable');
    const agents = await discoverLocalAgents({
      searchPath: directory,
      platform: 'linux',
      executableExtensions: [],
    });
    expect(agents.find(({ agent }) => agent.id === 'codex')?.installation).toEqual({
      status: 'found',
      path: join(directory, 'codex'),
    });
    expect(agents.find(({ agent }) => agent.id === 'claude-code')?.installation.status).toBe(
      'missing',
    );
    expect(agents.find(({ agent }) => agent.id === 'pi')?.installation.status).toBe('missing');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['/unused', ''])('honors cancellation even with search path %j', async (searchPath) => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    discoverLocalAgents({
      searchPath,
      platform: 'linux',
      executableExtensions: [],
      signal: controller.signal,
    }),
  ).rejects.toThrow();
});

it('prefers the first executable on PATH instead of whichever probe finishes first', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'always-on-path-order-'));
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  try {
    await Promise.all([mkdir(first), mkdir(second)]);
    const executables = [join(first, 'codex'), join(second, 'codex')];
    await Promise.all(executables.map(createExecutable));
    const agents = await discoverLocalAgents({
      searchPath: [first, second].join(delimiter),
      platform: 'linux',
      executableExtensions: [],
    });
    expect(agents.find(({ agent }) => agent.id === 'codex')?.installation).toEqual({
      status: 'found',
      path: join(first, 'codex'),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createExecutable(commandPath: string) {
  await writeFile(commandPath, '#!/bin/sh\nexit 0\n');
  await chmod(commandPath, 0o755);
}
