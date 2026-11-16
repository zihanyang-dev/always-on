import { addAbortListener } from 'node:events';
import { SESSION_EVENT_SCHEMA, type SessionEvent } from '@always-on/contracts/agents';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { openRedis } from '../infrastructure/redis/index.js';

const EVENT_STREAM_MAX_LENGTH = 2_000;
const EVENT_RETENTION_SECONDS = 7_200;
const MAX_STREAM_COMPONENT = 18_446_744_073_709_551_615n;
const STREAM_ENTRY_SCHEMA = z.tuple([z.string(), z.array(z.string())]);
const STREAM_READ_SCHEMA = z.array(z.tuple([z.string(), z.array(STREAM_ENTRY_SCHEMA)])).nullable();

/** Erases transient conversation content after execution has been fenced by deletion. */
export async function deleteSessionEvents({
  redis,
  prefix,
  sessionId,
}: {
  redis: Redis;
  prefix: string;
  sessionId: string;
}): Promise<void> {
  await redis.del(getStreamKey({ prefix, sessionId }));
}

/** A bounded Redis cursor accepted by both replay and Last-Event-ID. */
export const SESSION_CURSOR_SCHEMA = z
  .string()
  .regex(/^\d{1,20}-\d{1,20}$/)
  .refine((cursor) => cursor.split('-').every((part) => BigInt(part) <= MAX_STREAM_COMPONENT));

/** Acknowledges publication only after both append and retention have succeeded. */
export async function publishSessionEvent({
  redis,
  prefix,
  sessionId,
  event,
}: {
  redis: Redis;
  prefix: string;
  sessionId: string;
  event: SessionEvent;
}): Promise<void> {
  const key = getStreamKey({ prefix, sessionId });
  const replies = await redis
    .multi()
    .xadd(key, 'MAXLEN', '~', EVENT_STREAM_MAX_LENGTH, '*', 'event', JSON.stringify(event))
    .expire(key, EVENT_RETENTION_SECONDS)
    .exec();
  if (!replies)
    throw new Error(`Session ${sessionId} stream publication returned no acknowledgement`);

  for (const [error] of replies) {
    if (error) throw new Error(`Session ${sessionId} stream publication failed`, { cause: error });
  }
}

/** Owns one blocking reader; browser cancellation never shares the queue's Redis connection. */
export interface SessionEventReader extends AsyncDisposable {
  readonly shouldReset: boolean;
  readonly read: () => Promise<readonly { id: string; event: SessionEvent }[]>;
}

/** Opens replay with an explicit reset for expired, missing or future cursors. */
export async function openSessionEventReader({
  redisUrl,
  prefix,
  sessionId,
  cursor,
  signal,
  onError,
}: {
  redisUrl: string;
  prefix: string;
  sessionId: string;
  cursor: string;
  signal: AbortSignal;
  onError: (error: Error) => void;
}): Promise<SessionEventReader> {
  await using startup = new AsyncDisposableStack();
  const connection = startup.use(openRedis({ url: redisUrl, role: 'api', onError }));
  startup.use(addAbortListener(signal, connection.disconnect));
  signal.throwIfAborted();
  await connection.client.connect();
  const key = getStreamKey({ prefix, sessionId });
  const [first, last] = await Promise.all([
    connection.client.xrange(key, '-', '+', 'COUNT', 1),
    connection.client.xrevrange(key, '+', '-', 'COUNT', 1),
  ]);
  const firstId = first.at(0)?.[0];
  const lastId = last.at(0)?.[0];
  const shouldReset =
    cursor !== '0-0' &&
    (!firstId ||
      !lastId ||
      compareCursors(cursor, firstId) < 0 ||
      compareCursors(cursor, lastId) > 0);
  let position = shouldReset ? '0-0' : cursor;
  const resources = startup.move();

  return { shouldReset, read, [Symbol.asyncDispose]: resources.disposeAsync.bind(resources) };

  async function read() {
    signal.throwIfAborted();
    const response: unknown = await connection.client.xread(
      'COUNT',
      100,
      'BLOCK',
      1_000,
      'STREAMS',
      key,
      position,
    );
    const streams = STREAM_READ_SCHEMA.parse(response);
    const entries = streams?.flatMap(([, messages]) => messages) ?? [];
    const events = entries.map(parseEntry);
    const lastEvent = events.at(-1);
    if (lastEvent) position = lastEvent.id;

    return events;
  }

  function parseEntry([id, fields]: z.infer<typeof STREAM_ENTRY_SCHEMA>) {
    SESSION_CURSOR_SCHEMA.parse(id);
    const [name, serialized] = fields;
    if (name !== 'event' || serialized === undefined || fields.length !== 2)
      throw new Error(`Session ${sessionId} has a malformed stream entry ${id}`);

    const input: unknown = JSON.parse(serialized);
    const event = SESSION_EVENT_SCHEMA.parse(input);
    // Tool progress carries only a Run ID; message and Run payloads also identify their Session.
    if (event.type === 'tool') return { id, event };

    const eventSessionId = event.type === 'message' ? event.message.sessionId : event.run.sessionId;
    if (eventSessionId !== sessionId)
      throw new Error(`Session ${sessionId} stream contains an event from another session`);

    return { id, event };
  }
}

function getStreamKey({ prefix, sessionId }: { prefix: string; sessionId: string }) {
  return `${prefix}:session:${sessionId}:events`;
}

function compareCursors(first: string, second: string) {
  const left = first
    .split('-')
    .map((part) => part.padStart(20, '0'))
    .join('-');
  const right = second
    .split('-')
    .map((part) => part.padStart(20, '0'))
    .join('-');
  if (left === right) return 0;
  if (left < right) return -1;

  return 1;
}
