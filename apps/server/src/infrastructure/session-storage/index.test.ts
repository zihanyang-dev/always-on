import { mkdir, mkdtempDisposable, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { deleteSessionFiles, getRunDirectory } from './index.js';

it('removes every attempt of one Session while retaining other conversations and provider files', async () => {
  await using storage = await mkdtempDisposable(join(tmpdir(), 'always-on-session-storage-'));
  const directory = storage.path;
  const first = getRunDirectory({ directory, sessionId: 'first', runId: 'run', ownerToken: 'old' });
  const second = getRunDirectory({
    directory,
    sessionId: 'first',
    runId: 'run',
    ownerToken: 'new',
  });
  const other = getRunDirectory({
    directory,
    sessionId: 'other',
    runId: 'run',
    ownerToken: 'owner',
  });
  const provider = join(directory, 'providers', 'model');
  const directories = [first, second, other, provider];
  await Promise.all(directories.map((path) => mkdir(path, { recursive: true })));
  await Promise.all(directories.map((path) => writeFile(join(path, 'history'), path)));

  await deleteSessionFiles({ directory, sessionId: 'first' });
  await deleteSessionFiles({ directory, sessionId: 'first' });

  await expect(readFile(join(first, 'history'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(second, 'history'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(other, 'history'), 'utf8')).toBe(other);
  expect(await readFile(join(provider, 'history'), 'utf8')).toBe(provider);
});

it('rejects storage identities that escape or alias their dedicated directory', async () => {
  await using storage = await mkdtempDisposable(join(tmpdir(), 'always-on-session-storage-'));
  const directory = storage.path;
  const identities = ['', '.', '..', '../providers', 'child/../alias', '/tmp/outside'];

  await Promise.all(
    identities.map((sessionId) =>
      expect(deleteSessionFiles({ directory, sessionId })).rejects.toThrow(
        'Invalid Session storage identity',
      ),
    ),
  );
  expect(() =>
    getRunDirectory({ directory, sessionId: 'valid', runId: '../other', ownerToken: 'owner' }),
  ).toThrow('Invalid Session storage identity');
  expect(() =>
    getRunDirectory({ directory, sessionId: 'valid', runId: 'run', ownerToken: '../other' }),
  ).toThrow('Invalid Session storage identity');
});

it('removes a Session symlink without following it into another directory', async () => {
  await using storage = await mkdtempDisposable(join(tmpdir(), 'always-on-session-storage-'));
  const directory = storage.path;
  const outside = join(directory, 'retained');
  await Promise.all([mkdir(outside), mkdir(join(directory, 'sessions'))]);
  await writeFile(join(outside, 'evidence'), 'retain');
  await symlink(outside, join(directory, 'sessions', 'linked'));

  await deleteSessionFiles({ directory, sessionId: 'linked' });

  expect(await readFile(join(outside, 'evidence'), 'utf8')).toBe('retain');
});
