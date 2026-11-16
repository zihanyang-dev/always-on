import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Names an isolated Run attempt within the Session-owned persistent storage tree. */
export function getRunDirectory({
  directory,
  sessionId,
  runId,
  ownerToken,
}: {
  directory: string;
  sessionId: string;
  runId: string;
  ownerToken: string;
}): string {
  const sessionDirectory = getSessionDirectory({ directory, sessionId });
  const runDirectory = getChildDirectory({ directory: sessionDirectory, identity: runId });

  return getChildDirectory({ directory: runDirectory, identity: ownerToken });
}

/** Removes all attempts for one Session without interpreting an opaque SDK checkpoint path. */
export async function deleteSessionFiles({
  directory,
  sessionId,
}: {
  directory: string;
  sessionId: string;
}): Promise<void> {
  const target = getSessionDirectory({ directory, sessionId });
  // force covers an interrupted prior deletion; permission and I/O errors still propagate.
  await rm(target, { recursive: true, force: true });
}

function getSessionDirectory({ directory, sessionId }: { directory: string; sessionId: string }) {
  return getChildDirectory({ directory: resolve(directory, 'sessions'), identity: sessionId });
}

function getChildDirectory({ directory, identity }: { directory: string; identity: string }) {
  const target = resolve(directory, identity);
  if (dirname(target) !== directory || identity !== target.slice(directory.length + 1))
    throw new Error(`Invalid Session storage identity ${identity}`);

  return target;
}
