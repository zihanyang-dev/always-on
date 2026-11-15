import type { SSEStreamingApi } from 'hono/streaming';
import type { Database } from '../infrastructure/database/index.js';
import { openSessionEventReader } from './events.js';
import { readSessionRevision, readSessionSnapshot } from './store.js';

/** Owns replay and the dedicated Redis connection for one accepted SSE subscription. */
export async function consumeSessionEvents({
  stream,
  db,
  sessionId,
  userId,
  cursor,
  redisUrl,
  prefix,
  requestSignal,
  hasValidLogin,
  onError,
}: {
  stream: SSEStreamingApi;
  db: Database;
  sessionId: string;
  userId: string;
  cursor: string;
  redisUrl: string;
  prefix: string;
  requestSignal: AbortSignal;
  hasValidLogin: () => Promise<boolean>;
  onError: (error: Error) => void;
}): Promise<void> {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([cancellation.signal, requestSignal]);
  stream.onAbort(() => cancellation.abort());
  await using reader = await openSessionEventReader({
    redisUrl,
    prefix,
    sessionId,
    cursor,
    signal,
    onError,
  });
  const access = { db, sessionId, userId };
  const [snapshot, isLoggedIn] = await Promise.all([readSessionSnapshot(access), hasValidLogin()]);
  if (!snapshot || !isLoggedIn) return writeRevoked(stream);
  let revision = snapshot.session.revision;
  await stream.writeSSE({
    event: reader.shouldReset ? 'reset' : 'snapshot',
    data: JSON.stringify(snapshot),
    ...(reader.shouldReset ? { id: '0-0' } : {}),
  });
  while (!signal.aborted) {
    const events = await reader.read();
    // Login revocation and resource membership both apply to already accepted subscriptions.
    const [isLoggedIn, currentRevision] = await Promise.all([
      hasValidLogin(),
      readSessionRevision(access),
    ]);
    if (!isLoggedIn || currentRevision === null) return writeRevoked(stream);
    for (const entry of events)
      await stream.writeSSE({ id: entry.id, event: 'update', data: JSON.stringify(entry.event) });
    if (events.length > 0) continue;
    if (currentRevision !== revision) {
      // Cancellation, lease expiry and lost Redis notifications still leave authoritative PG facts.
      const snapshot = await readSessionSnapshot(access);
      if (!snapshot) return writeRevoked(stream);
      revision = snapshot.session.revision;
      await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot) });
      continue;
    }
    await stream.writeSSE({ event: 'ping', data: '{}' });
  }
}

async function writeRevoked(stream: SSEStreamingApi) {
  await stream.writeSSE({ event: 'access_revoked', data: '{}' });
}
