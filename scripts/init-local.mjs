import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

try {
  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const contents = template.replace(
    'BETTER_AUTH_SECRET=generate-on-init',
    `BETTER_AUTH_SECRET=${randomBytes(32).toString('base64url')}`,
  );
  // Exclusive creation preserves local edits and credentials when setup is repeated.
  await writeFile(new URL('../.env.local', import.meta.url), contents, { flag: 'wx', mode: 0o600 });
  console.log('Created .env.local with isolated development services.');
} catch (error) {
  if (!(error instanceof Error))
    throw new Error('Cannot initialize local configuration', { cause: error });
  if (!('code' in error) || error.code !== 'EEXIST') throw error;
  console.log('Keeping existing .env.local.');
}
