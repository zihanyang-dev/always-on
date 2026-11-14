import type { BetterAuthRateLimitOptions } from 'better-auth';
import type { Redis } from 'ioredis';
import { z } from 'zod';

const LIMIT_RESULT_SCHEMA = z.tuple([z.union([z.literal(0), z.literal(1)]), z.number()]);
const CONSUME_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  redis.call('SET', KEYS[1], 1, 'PX', ARGV[1])
  return {1, 0}
end
if count >= tonumber(ARGV[2]) then
  return {0, math.ceil(ttl / 1000)}
end
redis.call('INCR', KEYS[1])
-- Accepted requests extend the SDK's inactivity window; blocked attempts do not.
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return {1, 0}
`;

/** Uses the SDK's atomic storage contract so simultaneous requests share one limit. */
export function createAuthRateLimit({
  redis,
  prefix,
}: {
  redis: Redis;
  prefix: string;
}): NonNullable<BetterAuthRateLimitOptions['customStorage']> {
  return { consume };

  async function consume(key: string, { window, max }: { window: number; max: number }) {
    // A single Redis operation closes the concurrent bypass between reading and updating a counter.
    const result = await redis.eval(
      CONSUME_SCRIPT,
      1,
      `${prefix}:auth:rate:${key}`,
      window * 1_000,
      max,
    );
    const [allowed, retryAfter] = LIMIT_RESULT_SCHEMA.parse(result);
    return { allowed: allowed === 1, retryAfter: allowed === 1 ? null : retryAfter };
  }
}
