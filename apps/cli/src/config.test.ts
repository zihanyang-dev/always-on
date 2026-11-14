import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadCliConfig, parseAgentSearchEnv } from './config.js';

it('ignores platform settings when parsing local discovery configuration', () => {
  expect(
    parseAgentSearchEnv({
      PATH: '/local/bin',
      ALWAYS_ON_CONFIG: '/missing/config.json',
      ALWAYS_ON_URL: 'invalid-platform-url',
    }),
  ).toEqual({ searchPath: '/local/bin', executableExtensions: ['.COM', '.EXE', '.BAT', '.CMD'] });
});

it('resolves explicit URL before environment and saved preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'always-on-config-'));
  const configPath = join(directory, 'config.json');
  try {
    await writeFile(configPath, JSON.stringify({ serverUrl: 'https://saved.example' }));
    const options = {
      environment: {
        ALWAYS_ON_CONFIG: configPath,
        ALWAYS_ON_URL: 'https://environment.example',
      },
      homeDirectory: directory,
      platform: 'linux',
    } as const;
    expect(
      (
        await loadCliConfig({
          ...options,
          serverUrl: 'https://explicit.example',
        })
      ).serverUrl,
    ).toBe('https://explicit.example');
    expect((await loadCliConfig({ ...options, serverUrl: undefined })).serverUrl).toBe(
      'https://environment.example',
    );
    expect(
      (
        await loadCliConfig({
          ...options,
          environment: { ALWAYS_ON_CONFIG: configPath },
          serverUrl: undefined,
        })
      ).serverUrl,
    ).toBe('https://saved.example');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not silently ignore an explicitly selected missing settings file', async () => {
  await expect(
    loadCliConfig({
      environment: { ALWAYS_ON_CONFIG: '/missing/always-on-config.json' },
      serverUrl: undefined,
      homeDirectory: '/unused',
      platform: 'linux',
    }),
  ).rejects.toThrow('Cannot read CLI settings');
});
