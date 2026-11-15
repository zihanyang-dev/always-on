import type { Readiness } from '@always-on/contracts/system';

/** Backing-service probes supplied by the process resource owners. */
export type ReadinessChecks = {
  database: () => Promise<unknown>;
  redis: () => Promise<unknown>;
};

/** Checks independent services concurrently and returns no underlying error details. */
export async function checkReadiness(checks: ReadinessChecks): Promise<Readiness> {
  const [database, redis] = await Promise.allSettled([checks.database(), checks.redis()]);
  // Construct valid snapshots directly; the summary cannot disagree with its checks.
  if (database.status === 'rejected')
    return {
      status: 'unavailable',
      checks: { database: 'down', redis: redis.status === 'fulfilled' ? 'up' : 'down' },
    };
  if (redis.status === 'rejected')
    return { status: 'unavailable', checks: { database: 'up', redis: 'down' } };

  return { status: 'ready', checks: { database: 'up', redis: 'up' } };
}
