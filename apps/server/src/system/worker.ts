import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { openRedis } from '../infrastructure/redis/index.js';

const CHECK_INPUT_SCHEMA = z.object({ checkId: z.uuid() });
const SYSTEM_CHECK_QUEUE_NAME = 'system-checks';
const WORKER_DRAIN_TIMEOUT_MS = 5_000;
const EVENT_STREAM_MAX_LENGTH = 1_000;
const EVENT_RETENTION_SECONDS = 7_200;

/** Result persisted by BullMQ and emitted to the system diagnostics stream. */
export const SYSTEM_CHECK_RESULT_SCHEMA = z.object({
  checkId: z.uuid(),
  completedAt: z.iso.datetime(),
});
/** A completed infrastructure check; it does not represent an Agent Run. */
export type SystemCheckResult = z.infer<typeof SYSTEM_CHECK_RESULT_SCHEMA>;

/** Diagnostic consumer whose work is drained before its connection closes. */
export interface SystemWorkerResource extends AsyncDisposable {
  readonly ready: () => Promise<void>;
}

/** Opens the diagnostic queue with bounded history and retry policy. */
export function openSystemCheckQueue({
  redis,
  prefix,
}: {
  redis: Redis;
  prefix: string;
}): Queue<unknown, SystemCheckResult> {
  return new Queue<unknown, SystemCheckResult>(SYSTEM_CHECK_QUEUE_NAME, {
    connection: redis,
    prefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 100 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });
}

/** Opens a Worker that verifies PG and writes an expiring Redis Stream event. */
export function openSystemWorker({
  redisUrl,
  prefix,
  concurrency,
  checkDatabase,
  now,
  onError,
}: {
  redisUrl: string;
  prefix: string;
  concurrency: number;
  checkDatabase: () => Promise<void>;
  now: () => string;
  onError: (error: Error) => void;
}): SystemWorkerResource {
  // The consumer owns its connection so forced shutdown cannot interrupt another module's work.
  const connection = openRedis({ url: redisUrl, role: 'worker', onError });
  const worker = new Worker<unknown, SystemCheckResult>(SYSTEM_CHECK_QUEUE_NAME, processCheck, {
    connection: connection.client,
    prefix,
    concurrency,
  });
  worker.on('error', onError);
  worker.on('failed', (job, error) =>
    onError(new Error(`System check job ${job?.id ?? 'unknown'} failed`, { cause: error })),
  );
  return {
    ready,
    [Symbol.asyncDispose]: dispose,
  };

  async function ready() {
    await worker.waitUntilReady();
  }

  async function processCheck(job: { name: string; data: unknown }) {
    if (job.name !== 'check') throw new Error(`Unsupported system job ${job.name}`);
    const input = CHECK_INPUT_SCHEMA.parse(job.data);
    await checkDatabase();
    const result = SYSTEM_CHECK_RESULT_SCHEMA.parse({
      checkId: input.checkId,
      completedAt: now(),
    });
    await publishSystemCheck({ redis: connection.client, prefix, result });
    return result;
  }

  async function dispose() {
    await using ownedConnection = connection;
    const deadline = AbortSignal.timeout(WORKER_DRAIN_TIMEOUT_MS);
    // Redis may disappear while an active job is recording its result. Release pending I/O at the deadline.
    deadline.addEventListener('abort', ownedConnection.disconnect, { once: true });
    const [closed] = await Promise.allSettled([worker.close()]);
    deadline.removeEventListener('abort', ownedConnection.disconnect);
    if (deadline.aborted)
      throw new Error(`System worker ${prefix} did not drain within ${WORKER_DRAIN_TIMEOUT_MS}ms`, {
        cause: closed.status === 'rejected' ? closed.reason : deadline.reason,
      });
    if (closed.status === 'fulfilled') return;
    if (closed.reason instanceof Error) throw closed.reason;
    throw new Error(`Cannot stop system worker ${prefix}`, { cause: closed.reason });
  }
}

async function publishSystemCheck({
  redis,
  prefix,
  result,
}: {
  redis: Redis;
  prefix: string;
  result: SystemCheckResult;
}) {
  const streamKey = `${prefix}:system:events`;
  // Append and retention share one transaction, preventing an unexpired stream after a crash.
  const replies = await redis
    .multi()
    .xadd(streamKey, 'MAXLEN', '~', EVENT_STREAM_MAX_LENGTH, '*', 'event', JSON.stringify(result))
    .expire(streamKey, EVENT_RETENTION_SECONDS)
    .exec();
  if (!replies) throw new Error(`System check ${result.checkId} returned no publication result`);
  for (const [error] of replies) {
    if (error) throw new Error(`Cannot publish system check ${result.checkId}`, { cause: error });
  }
}
