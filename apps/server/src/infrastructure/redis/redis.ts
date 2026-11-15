import { Redis } from 'ioredis';

const REDIS_COMMAND_TIMEOUT_MS = 3_000;
const REDIS_DRAIN_TIMEOUT_MS = 3_000;

/** Redis connection whose owner must await disposal after dependent workers close. */
export interface RedisResource extends AsyncDisposable {
  readonly client: Redis;
  readonly disconnect: () => void;
}

/** Creates a lazy connection with retry behavior appropriate to its process role. */
export function openRedis({
  url,
  role,
  onError,
}: {
  url: string;
  role: 'api' | 'worker';
  onError: (error: Error) => void;
}): RedisResource {
  let isStopping = false;
  const client = new Redis(url, {
    lazyConnect: true,
    // API probes must finish; BullMQ's blocking connection must be allowed to wait.
    commandTimeout: role === 'api' ? REDIS_COMMAND_TIMEOUT_MS : undefined,
    maxRetriesPerRequest: role === 'worker' ? null : 1,
    connectTimeout: 2_000,
    retryStrategy: (attempt) => (isStopping ? null : Math.min(attempt * 200, 2_000)),
  });
  client.on('error', onError);

  return { client, disconnect, [Symbol.asyncDispose]: dispose };

  function disconnect() {
    isStopping = true;
    // ioredis cannot flush offline commands by disconnecting an already closed socket.
    // Let the pending reconnect finish: failure stops retries; success closes before sending work.
    if (client.status === 'reconnecting') {
      client.once('connect', closeTransport);

      return;
    }

    closeTransport();
  }

  function closeTransport() {
    client.disconnect();
  }

  async function dispose() {
    if (client.status === 'end') return;

    const { promise: ended, resolve } = Promise.withResolvers<void>();
    client.once('end', resolve);
    // QUIT can queue behind offline work. Disconnect bounds that wait and rejects pending commands.
    const deadline = setTimeout(disconnect, REDIS_DRAIN_TIMEOUT_MS);
    deadline.unref();

    try {
      await client.quit();
    } finally {
      clearTimeout(deadline);
      disconnect();
      await ended;
      client.off('connect', closeTransport);
    }
  }
}
