import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

test('the API correlates request logs and exports traces and metrics over OTLP', async () => {
  const exported = new Map<string, string>();
  const collector = createServer((request, response) => {
    let payload = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      payload += chunk;
    });
    request.once('end', () => {
      if (request.url) exported.set(request.url, payload);
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
    });
  });

  await using receiver = collector.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  const collectorPort = portOf(receiver);

  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = portOf(listener);
  await listener[Symbol.asyncDispose]();

  const origin = `http://127.0.0.1:${port}`;
  const api = spawn(process.execPath, ['apps/server/src/entrypoints/api.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: 'telemetry-integration-secret-not-a-real-credential',
      DATABASE_URL: 'postgresql://127.0.0.1:1/unused',
      LOG_LEVEL: 'info',
      OTEL_SERVICE_NAME: 'always-on-telemetry-test',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}/collector`,
    },
  });
  const exited = once(api, 'exit');
  let logs = '';
  let stderr = '';
  api.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    logs += chunk;
  });
  api.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });

  const traceId = '0123456789abcdef0123456789abcdef';
  const parentId = '0123456789abcdef';
  const secret = 'query-value-that-must-not-be-logged';
  let requestId: string | null = null;
  try {
    const signal = AbortSignal.timeout(5000);
    await Promise.race([
      once(api.stdout, 'data', { signal }),
      exited.then(([code]) => {
        throw new Error(`API exited before listening (${code}): ${stderr}`);
      }),
    ]);
    assert.match(logs, /"msg":"api\.listening"/);

    const result = await fetch(`${origin}/health?token=${secret}`, {
      headers: { traceparent: `00-${traceId}-${parentId}-01` },
      signal,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { status: 'ok' });

    requestId = result.headers.get('X-Request-Id');
    assert.match(requestId ?? '', /^[a-f0-9-]{36}$/);
  } finally {
    if (api.exitCode === null && api.signalCode === null) api.kill('SIGTERM');

    const [status] = await exited;
    assert.equal(status, 0, stderr);
  }

  assert.ok(requestId);
  const requestLog = logs.split('\n').find((line) => line.includes(requestId));
  assert.ok(requestLog);
  assert.ok(requestLog.includes(`"trace_id":"${traceId}"`));
  assert.match(requestLog, /"route":"\/health"/);
  assert.match(requestLog, /"status":200/);
  assert.equal(logs.includes(secret), false);

  const spans = exported.get('/collector/v1/traces');
  assert.ok(spans);
  assert.ok(spans.includes(traceId));
  assert.ok(spans.includes(parentId));
  assert.match(spans, /GET \/health/);
  assert.equal(spans.includes(secret), false);

  const metrics = exported.get('/collector/v1/metrics');
  assert.ok(metrics);
  assert.match(metrics, /http\.server\.request\.duration/);
  assert.match(metrics, /http\.route/);
  assert.match(metrics, /\/health/);
  assert.equal(metrics.includes(secret), false);
  assert.equal(metrics.includes(requestId), false);
});

function portOf(server: ReturnType<typeof createServer>) {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}
