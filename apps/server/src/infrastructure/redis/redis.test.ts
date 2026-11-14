import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { openRedis } from './index.js';

it('releases queued commands when Redis stays offline during disposal', async () => {
  const url = await getUnavailableRedisUrl();
  const errors: Error[] = [];
  await using redis = openRedis({
    url,
    role: 'worker',
    onError: (error) => {
      errors.push(error);
    },
  });
  await expect(redis.client.connect()).rejects.toThrow();
  const pending = redis.client.ping();
  // Observe both promises immediately so teardown failures cannot become unhandled rejections.
  const [closed, command] = await Promise.allSettled([redis[Symbol.asyncDispose](), pending]);
  assert.ok(closed.status === 'rejected');
  assert.ok(command.status === 'rejected');
  expect(errors.length).toBeGreaterThan(0);
}, 8_000);

async function getUnavailableRedisUrl() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await promisify(listener.close.bind(listener))();
  return `redis://127.0.0.1:${address.port}`;
}
