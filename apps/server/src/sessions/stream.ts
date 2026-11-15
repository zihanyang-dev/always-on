import type { Context } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import type { AuthenticatedApiEnv } from '../api/index.js';
import type { Database } from '../infrastructure/database/index.js';
import { openSessionEventReader } from './events.js';
import { readSessionRevision, readSessionSnapshot } from './store.js';

/** Redis transport settings shared by subscriptions, separate from per-request identity. */
export type SessionStreamConnection = {
  readonly redisUrl: string;
  readonly prefix: string;
  readonly onError: (error: Error) => void;
};

type SessionSubscription = {
  readonly db: Database;
  readonly sessionId: string;
  readonly userId: string;
  readonly cursor: string;
  readonly connection: SessionStreamConnection;
  readonly hasValidLogin: () => Promise<boolean>;
};

interface ActiveSubscription extends SessionSubscription {
  readonly stream: SSEStreamingApi;
  readonly requestSignal: AbortSignal;
}

/** Owns the HTTP stream, including cancellation and dependency-failure reporting. */
export function streamSessionEvents(
  ctx: Context<AuthenticatedApiEnv>,
  subscription: SessionSubscription,
): Response {
  const requestSignal = ctx.req.raw.signal;

  return streamSSE(
    ctx,
    (stream) => consumeSessionEvents({ ...subscription, stream, requestSignal }),
    reportFailure,
  );

  async function reportFailure(error: Error, stream: SSEStreamingApi) {
    // A closed browser connection is normal; dependency failures on a live stream need reporting.
    if (stream.aborted || requestSignal.aborted) return;

    subscription.connection.onError(error);
    await stream.writeSSE({ event: 'unavailable', data: '{"code":"stream_unavailable"}' });
  }
}

async function consumeSessionEvents({
  stream,
  db,
  sessionId,
  userId,
  cursor,
  connection,
  requestSignal,
  hasValidLogin,
}: ActiveSubscription) {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([cancellation.signal, requestSignal]);
  // Subscription cancellation owns only its Redis reader, never the executing Run.
  stream.onAbort(() => cancellation.abort());
  await using reader = await openSessionEventReader({
    ...connection,
    sessionId,
    cursor,
    signal,
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

  // Replay may overlap the snapshot; consumers merge by identity and confirmed message state.
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
