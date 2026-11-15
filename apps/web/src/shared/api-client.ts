import {
  PUBLIC_CONFIG_SCHEMA,
  type PublicConfig,
  READINESS_SCHEMA,
  type Readiness,
} from '@always-on/contracts/system';
import { queryOptions } from '@tanstack/react-query';

const API_TIMEOUT_MS = 5_000;

/** Shares one cached public-settings request between the app shell and setup feature. */
export const PUBLIC_CONFIG_QUERY = queryOptions({
  queryKey: ['public-config'],
  queryFn: ({ signal }) => getPublicConfig(signal),
});

/** Loads only the public deployment allowlist and cancels abandoned requests. */
export async function getPublicConfig(signal?: AbortSignal): Promise<PublicConfig> {
  const response = await fetch('/api/public-config', {
    signal: getRequestSignal(signal),
  });
  if (!response.ok) throw new Error(`Public configuration returned HTTP ${response.status}`);

  return PUBLIC_CONFIG_SCHEMA.parse(await response.json());
}

/** Parses both ready and unavailable responses without exposing server errors. */
export async function getReadiness(signal?: AbortSignal): Promise<Readiness> {
  const response = await fetch('/api/health/ready', { signal: getRequestSignal(signal) });
  if (response.status !== 200 && response.status !== 503)
    throw new Error(`Readiness endpoint returned HTTP ${response.status}`);

  return READINESS_SCHEMA.parse(await response.json());
}

function getRequestSignal(signal: AbortSignal | undefined) {
  // Query cancellation and a stalled-response deadline must remain effective together.
  const deadline = AbortSignal.timeout(API_TIMEOUT_MS);
  if (!signal) return deadline;

  return AbortSignal.any([signal, deadline]);
}
