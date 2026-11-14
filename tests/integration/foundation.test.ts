import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { promisify } from 'node:util';
import { QueueEvents } from 'bullmq';
import { inArray } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { parseWorkerEnv } from '../../apps/server/src/bootstrap/env.js';
import { INBOX_EVENTS, openDatabase } from '../../apps/server/src/infrastructure/database/index.js';
import { openRedis, type RedisResource } from '../../apps/server/src/infrastructure/redis/index.js';
import { appendInboxEvent } from '../../apps/server/src/sessions/index.js';
import {
  openSystemCheckQueue,
  openSystemWorker,
  SYSTEM_CHECK_RESULT_SCHEMA,
} from '../../apps/server/src/system/index.js';

const ENV = parseWorkerEnv(process.env);

it('deduplicates concurrent Inbox deliveries within their trusted scope', async () => {
  await using fixture = openInboxFixture();
  const { db, scopeId, secondScopeId } = fixture;
  const event = {
    source: 'integration',
    sourceEventId: 'delivery-1',
    payload: { text: 'hello' },
  };
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () => appendInboxEvent({ db, scopeId, event })),
  );
  expect(outcomes.filter((outcome) => outcome.status === 'accepted')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'duplicate')).toHaveLength(7);
  const otherScope = await appendInboxEvent({
    db,
    scopeId: secondScopeId,
    event,
  });
  expect(otherScope.status).toBe('accepted');
  const invalid = await appendInboxEvent({
    db,
    scopeId,
    event: { source: 'integration' },
  });
  expect(invalid.status).toBe('invalid');
});

it('consumes a BullMQ job, checks PG, and writes a bounded Redis Stream', async () => {
  const prefix = `test-${randomUUID()}`;
  const checkId = randomUUID();
  const errors: Error[] = [];
  const onError = (error: Error) => {
    errors.push(error);
  };
  await using database = openDatabase({ url: ENV.DATABASE_URL, onError });
  await using redis = openRedis({
    url: ENV.REDIS_URL,
    role: 'worker',
    onError,
  });
  await redis.client.connect();
  await using fixture = openQueueFixture({ redis: redis.client, prefix });
  await fixture.events.waitUntilReady();
  await using worker = openSystemWorker({
    redisUrl: ENV.REDIS_URL,
    prefix,
    concurrency: 1,
    checkDatabase: database.check,
    now: () => '2026-11-14T00:00:00.000Z',
    onError,
  });
  await worker.ready();
  const job = await fixture.queue.add('check', { checkId });
  const result: unknown = await job.waitUntilFinished(fixture.events, 10_000);
  expect(SYSTEM_CHECK_RESULT_SCHEMA.parse(result).checkId).toBe(checkId);
  const entries = await redis.client.xrange(`${prefix}:system:events`, '-', '+');
  const serialized = entries.at(0)?.[1].at(1);
  assert.ok(serialized);
  const event: unknown = JSON.parse(serialized);
  expect(SYSTEM_CHECK_RESULT_SCHEMA.parse(event).checkId).toBe(checkId);
  expect(await redis.client.ttl(`${prefix}:system:events`)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

it('bounds active-worker shutdown after its Redis transport disappears', async () => {
  const prefix = `test-${randomUUID()}`;
  const errors: Error[] = [];
  const onError = (error: Error) => {
    errors.push(error);
  };
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await using redis = openRedis({ url: ENV.REDIS_URL, role: 'worker', onError });
  await redis.client.connect();
  await using fixture = openQueueFixture({ redis: redis.client, prefix });
  await using relay = await openRedisRelay(ENV.REDIS_URL);
  await using worker = openSystemWorker({
    redisUrl: relay.url,
    prefix,
    concurrency: 1,
    checkDatabase: async () => {
      started.resolve();
      await release.promise;
    },
    now: () => '2026-11-14T00:00:00.000Z',
    onError,
  });
  try {
    await worker.ready();
    await fixture.queue.add('check', { checkId: randomUUID() });
    await started.promise;
    // Break only this consumer's transport; the test's producer remains connected.
    await relay[Symbol.asyncDispose]();
  } finally {
    release.resolve();
  }
  await expect(worker[Symbol.asyncDispose]()).rejects.toThrow('did not drain within');
  expect(await redis.client.ping()).toBe('PONG');
  expect(errors.length).toBeGreaterThan(0);
});

async function openRedisRelay(target: string) {
  const targetUrl = new URL(target);
  const sockets = new Set<Socket>();
  const server = createServer(acceptConnection);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const relayUrl = new URL(targetUrl);
  relayUrl.hostname = '127.0.0.1';
  relayUrl.port = String(address.port);
  let closing: Promise<void> | undefined;
  return { url: relayUrl.href, [Symbol.asyncDispose]: dispose };

  function acceptConnection(client: Socket) {
    const upstream = createConnection({
      host: targetUrl.hostname,
      port: Number(targetUrl.port || 6379),
    });
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream).pipe(client);
    // Closing the peer propagates transport errors to the real Redis client under test.
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
  }

  function dispose() {
    closing ??= closeConnections();
    return closing;
  }

  async function closeConnections() {
    const closed = promisify(server.close.bind(server))();
    for (const socket of sockets) socket.destroy();
    await closed;
  }
}

function openInboxFixture() {
  const scopeId = randomUUID();
  const secondScopeId = randomUUID();
  const database = openDatabase({
    url: ENV.DATABASE_URL,
    onError: (error) => {
      throw error;
    },
  });
  return {
    db: database.db,
    scopeId,
    secondScopeId,
    [Symbol.asyncDispose]: dispose,
  };

  async function dispose() {
    await using connection = database;
    await connection.db
      .delete(INBOX_EVENTS)
      .where(inArray(INBOX_EVENTS.scopeId, [scopeId, secondScopeId]));
  }
}

function openQueueFixture({ redis, prefix }: { redis: RedisResource['client']; prefix: string }) {
  const queue = openSystemCheckQueue({ redis, prefix });
  const events = new QueueEvents(queue.name, { connection: redis, prefix });
  return { queue, events, [Symbol.asyncDispose]: dispose };

  async function dispose() {
    const outcomes = await Promise.allSettled([events.close(), queue.close()]);
    const failures: unknown[] = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    try {
      await clearKeys();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Failed to release integration queue resources');
  }

  async function clearKeys() {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }
}
