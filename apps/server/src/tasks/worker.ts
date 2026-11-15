import { setTimeout as waitInterval } from 'node:timers/promises';
import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import type { Database } from '../infrastructure/database/index.js';
import { openRedis } from '../infrastructure/redis/index.js';
import { publishSessionEvent } from '../sessions/index.js';
import { executeQueuedRun, type RunExecutor } from './execute.js';
import { listQueuedRuns, recoverExpiredRuns } from './ownership.js';

const RUN_QUEUE_NAME = 'agent-runs';
const RUN_JOB_SCHEMA = z.strictObject({ runId: z.uuid() });

/** A running queue consumer; infrastructure failure wakes its owning process. */
export interface AgentWorkerResource extends AsyncDisposable {
  readonly failure: Promise<Error>;
}

/** Starts durable dispatch and execution without moving model work into a database transaction. */
export async function openAgentWorker({
  db,
  redisUrl,
  prefix,
  concurrency,
  execute,
  createId,
  onError,
}: {
  db: Database;
  redisUrl: string;
  prefix: string;
  concurrency: number;
  execute: RunExecutor;
  createId: () => string;
  onError: (error: Error) => void;
}): Promise<AgentWorkerResource> {
  await using startup = new AsyncDisposableStack();
  const consumer = startup.use(openRedis({ url: redisUrl, role: 'worker', onError }));
  const progress = startup.use(openRedis({ url: redisUrl, role: 'api', onError }));
  const queue = new Queue(RUN_QUEUE_NAME, {
    connection: progress.client,
    prefix,
    // Failed wake-ups must not retain the Run ID and block durable queued rows from redispatch.
    // Claimed or uncertain Runs are excluded by PostgreSQL, independently of queue retention.
    defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
  });
  startup.defer(() => queue.close());
  queue.on('error', onError);
  const worker = new Worker<unknown>(RUN_QUEUE_NAME, processRun, {
    connection: consumer.client,
    prefix,
    concurrency,
    autorun: false,
  });
  startup.defer(() => worker.close());
  worker.on('error', onError);
  worker.on('failed', (job, error) =>
    onError(new Error(`Agent queue job ${job?.id ?? 'unknown'} failed`, { cause: error })),
  );
  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
  const resources = startup.move();
  const stopping = new AbortController();
  const fatal = Promise.withResolvers<Error>();
  const dispatching = dispatchRuns();
  const consuming = consumeRuns();
  return { failure: fatal.promise, [Symbol.asyncDispose]: dispose };

  async function processRun(job: { name: string; data: unknown }) {
    if (job.name !== 'execute') throw new Error(`Unsupported Agent queue job ${job.name}`);
    const { runId } = RUN_JOB_SCHEMA.parse(job.data);
    await executeQueuedRun({
      db,
      runId,
      ownerToken: createId(),
      execute,
      signal: stopping.signal,
      onError,
      publish: (input) => publishSessionEvent({ redis: progress.client, prefix, ...input }),
    });
  }

  async function dispatchRuns() {
    try {
      while (!stopping.signal.aborted) {
        await recoverExpiredRuns(db);
        const runIds = await listQueuedRuns(db);
        if (runIds.length > 0)
          await queue.addBulk(
            runIds.map((runId) => ({ name: 'execute', data: { runId }, opts: { jobId: runId } })),
          );
        await waitInterval(1_000, undefined, { signal: stopping.signal });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'AbortError' &&
        error.cause === stopping.signal.reason
      )
        return;
      // Pending Run rows survive; let the process supervisor restart failed infrastructure.
      fatal.resolve(new Error('Agent dispatch loop failed', { cause: error }));
    }
  }

  async function consumeRuns() {
    try {
      await worker.run();
      if (!stopping.signal.aborted)
        fatal.resolve(new Error('Agent queue consumer stopped unexpectedly'));
    } catch (error) {
      fatal.resolve(new Error('Agent queue consumer failed', { cause: error }));
    }
  }

  async function dispose() {
    stopping.abort();
    // End dispatch before closing its producer; active Runs keep their leases until cleanup finishes.
    await dispatching;
    const outcomes = await Promise.allSettled([resources.disposeAsync(), consuming]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (failures.length > 0) throw new AggregateError(failures, 'Agent Worker shutdown failed');
  }
}
