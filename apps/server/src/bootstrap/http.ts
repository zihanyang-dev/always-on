import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';

const HTTP_DRAIN_TIMEOUT_MS = 5_000;

/** Listening endpoint with shutdown owned by its lexical resource scope. */
export interface HttpServerResource extends AsyncDisposable {
  readonly port: number;
}

/** Starts HTTP and owns graceful draining, including a bounded forced close. */
export async function openHttpServer({
  app,
  host,
  port,
}: {
  app: Hono;
  host: string;
  port: number;
}): Promise<HttpServerResource> {
  const server = createServer(getRequestListener(app.fetch));
  const closeServer = promisify(server.close.bind(server));
  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('HTTP server did not bind a TCP address');
  return { port: address.port, [Symbol.asyncDispose]: dispose };

  async function dispose() {
    // Drain active requests first; the deadline bounds clients that never finish a response.
    const deadline = setTimeout(server.closeAllConnections.bind(server), HTTP_DRAIN_TIMEOUT_MS);
    deadline.unref();
    try {
      await closeServer();
    } finally {
      clearTimeout(deadline);
    }
  }
}
