import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { openHttpServer } from './http.js';

it('drains an HTTP listener and closes keep-alive connections on disposal', async () => {
  let url = '';
  {
    const app = new Hono().get('/', (ctx) => ctx.text('ready'));
    await using server = await openHttpServer({
      app,
      host: '127.0.0.1',
      port: 0,
    });
    url = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(url)).text()).toBe('ready');
  }
  await expect(fetch(url)).rejects.toThrow();
});
