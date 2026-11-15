import { READINESS_SCHEMA } from '@always-on/contracts/system';
import type { CliResult, OutputFormat } from './command.js';

const STATUS_TIMEOUT_MS = 5_000;

/** Queries platform readiness and preserves unavailable responses as normal command output. */
export async function runStatusCommand({
  serverUrl,
  format,
  signal,
}: {
  serverUrl: string;
  format: OutputFormat;
  signal?: AbortSignal;
}): Promise<CliResult> {
  const deadline = AbortSignal.timeout(STATUS_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const url = new URL('/api/health/ready', serverUrl);
  const response = await fetch(url, { signal: requestSignal });
  // A 503 carries a useful readiness snapshot rather than an opaque transport error.
  if (response.status !== 200 && response.status !== 503)
    throw new Error(`Readiness endpoint ${url.origin} returned HTTP ${response.status}`);

  const readiness = READINESS_SCHEMA.parse(await response.json());
  const output =
    format === 'json'
      ? JSON.stringify(readiness, null, 2)
      : `Platform ${readiness.status} · database ${readiness.checks.database} · Redis ${readiness.checks.redis}`;

  return { output, exitCode: readiness.status === 'ready' ? 0 : 1 };
}
