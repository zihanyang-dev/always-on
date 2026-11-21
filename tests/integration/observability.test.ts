import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const PARENT_ID = '0123456789abcdef';
const QUERY_VALUE = 'query-value-that-must-not-be-logged';

test('the API correlates request logs and exports traces and metrics over OTLP', async () => {
  const exported = new Map<string, string>();
  await using collector = createCollector(exported).listen(0, '127.0.0.1');
  await once(collector, 'listening');

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const api = startApi({ port, origin, collectorPort: portOf(collector) });
  const exited = once(api, 'close');

  let logs = '';
  let stderr = '';
  api.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    logs += chunk;
  });
  api.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });

  let requestId: string;
  try {
    const signal = AbortSignal.timeout(5000);
    await Promise.race([once(api.stdout, 'data', { signal }), exitDuringStartup()]);
    assert.match(logs, /"msg":"api\.listening"/);

    requestId = await requestHealth(origin, signal);
  } finally {
    if (api.exitCode === null && api.signalCode === null) api.kill('SIGTERM');

    const [status] = await exited;
    assert.equal(status, 0, stderr);
  }

  verifyTelemetry({ logs, exported, requestId });

  async function exitDuringStartup() {
    const [status] = await exited;
    throw new Error(`API exited before listening (${status}): ${stderr}`);
  }
});

function createCollector(exported: Map<string, string>) {
  return createServer((request, response) => {
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
}

async function availablePort() {
  await using listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');

  return portOf(listener);
}

function startApi({
  origin,
  port,
  collectorPort,
}: {
  origin: string;
  port: number;
  collectorPort: number;
}) {
  return spawn(process.execPath, ['apps/server/src/entrypoints/api.ts'], {
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
}

async function requestHealth(origin: string, signal: AbortSignal) {
  const result = await fetch(`${origin}/health?token=${QUERY_VALUE}`, {
    headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` },
    signal,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: 'ok' });

  const requestId = result.headers.get('X-Request-Id');
  assert.ok(requestId);
  assert.match(requestId, /^[a-f0-9-]{36}$/);
  return requestId;
}

function verifyTelemetry({
  logs,
  exported,
  requestId,
}: {
  logs: string;
  exported: Map<string, string>;
  requestId: string;
}) {
  const requestLog = logs.split('\n').find((line) => line.includes(requestId));
  assert.ok(requestLog);
  assert.ok(requestLog.includes(`"trace_id":"${TRACE_ID}"`));
  assert.match(requestLog, /"route":"\/health"/);
  assert.match(requestLog, /"status":200/);
  assert.equal(logs.includes(QUERY_VALUE), false);

  const spans = exported.get('/collector/v1/traces');
  assert.ok(spans);
  assert.ok(spans.includes(TRACE_ID));
  assert.ok(spans.includes(PARENT_ID));
  assert.match(spans, /GET \/health/);
  assert.equal(spans.includes(QUERY_VALUE), false);

  const metrics = exported.get('/collector/v1/metrics');
  assert.ok(metrics);
  assert.match(metrics, /http\.server\.request\.duration/);
  assert.match(metrics, /http\.route/);
  assert.match(metrics, /\/health/);
  assert.equal(metrics.includes(QUERY_VALUE), false);
  assert.equal(metrics.includes(requestId), false);
}

function portOf(server: ReturnType<typeof createServer>) {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}
