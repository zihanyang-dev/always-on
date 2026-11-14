import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';

try {
  // Exclusive creation preserves local edits when setup is run more than once.
  await copyFile(
    new URL('../.env.example', import.meta.url),
    new URL('../.env.local', import.meta.url),
    constants.COPYFILE_EXCL,
  );
  console.log('Created .env.local with isolated development services.');
} catch (error) {
  if (!(error instanceof Error))
    throw new Error('Cannot initialize local configuration', { cause: error });
  if (!('code' in error) || error.code !== 'EEXIST') throw error;
  console.log('Keeping existing .env.local.');
}
