import { addAbortListener } from 'node:events';
import { setTimeout as waitInterval } from 'node:timers/promises';
import type { ExecutionContext } from '@always-on/agent-runtime/execution';
import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import type { Database } from '../infrastructure/database/index.js';
import { openRedis } from '../infrastructure/redis/index.js';
import {
  type DeleteSessionResources,
  deleteSessionEvents,
  listSessionDeletions,
  processSessionDeletion,
  publishSessionEvent,
  type SessionResources,
} from '../sessions/index.js';
import { executeQueuedRun, type RunExecutor } from './execute.js';
import { listQueuedRuns, type RunClaim, recoverExpiredRuns } from './ownership.js';

const AGENT_QUEUE_NAME = 'agent-runs';
const RUN_JOB_SCHEMA = z.strictObject({ runId: z.uuid() });
const DELETION_JOB_SCHEMA = z.strictObject({ sessionId: z.uuid() });
const QUEUE_DRAIN_TIMEOUT_MS = 5_000;

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
  deleteSessionResources,
}: {
  db: Database;
  redisUrl: string;
  prefix: string;
  concurrency: number;
  execute: RunExecutor;
  createId: () => string;
  onError: (error: Error) => void;
  deleteSessionResources?: DeleteSessionResources;
}): Promise<AgentWorkerResource> {
  const resourceWork = new Set<Promise<void>>();
  await using startup = new AsyncDisposableStack();
  const consumer = startup.use(openRedis({ url: redisUrl, role: 'worker', onError }));
  const progress = startup.use(openRedis({ url: redisUrl, role: 'api', onError }));

  const queue = new Queue(AGENT_QUEUE_NAME, {
    connection: progress.client,
    prefix,
    // Wake-up IDs must be removable so durable Run and cleanup requests can be redispatched.
    // PostgreSQL independently governs execution ownership and the next cleanup attempt.
    defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
  });
  startup.defer(() => queue.close());
  queue.on('error', onError);

  const worker = new Worker<unknown>(AGENT_QUEUE_NAME, processJob, {
    connection: consumer.client,
    prefix,
    concurrency,
    autorun: false,
  });
  startup.defer(closeWorker);
  worker.on('error', onError);
  worker.on('failed', (job, error) =>
    onError(new Error(`Agent queue job ${job?.id ?? 'unknown'} failed`, { cause: error })),
  );
  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);

  const resources = startup.move();
  const stopping = new AbortController();
  const fatal = Promise.withResolvers<Error>();
  const dispatching = dispatchJobs();
  const consuming = consumeRuns();

  return { failure: fatal.promise, [Symbol.asyncDispose]: dispose };

  async function processJob(job: { name: string; data: unknown }) {
    if (stopping.signal.aborted) return;

    switch (job.name) {
      case 'execute': {
        const { runId } = RUN_JOB_SCHEMA.parse(job.data);
        return executeQueuedRun({
          db,
          runId,
          ownerToken: createId(),
          execute: executeRun,
          signal: stopping.signal,
          onError,
          publish: (input) => publishSessionEvent({ redis: progress.client, prefix, ...input }),
        });
      }
      case 'delete-session': {
        const { sessionId } = DELETION_JOB_SCHEMA.parse(job.data);
        return processSessionDeletion({ db, sessionId, deleteResources, signal: stopping.signal });
      }
      default:
        throw new Error(`Unsupported Agent queue job ${job.name}`);
    }
  }

  async function executeRun(claim: RunClaim, context: ExecutionContext) {
    // Admission can finish after shutdown starts; release its claim through normal cancellation.
    if (stopping.signal.aborted) return { status: 'cancelled' as const, checkpoint: null };

    return trackResourceWork(execute(claim, context));
  }

  async function deleteResources(resources: SessionResources) {
    if (!deleteSessionResources) throw new Error('Session resource deletion is not configured');

    await trackResourceWork(deleteSessionResources(resources));
    await deleteSessionEvents({ redis: progress.client, prefix, sessionId: resources.sessionId });
  }

  async function trackResourceWork<TResult>(task: Promise<TResult>): Promise<TResult> {
    const settled = Promise.withResolvers<void>();
    resourceWork.add(settled.promise);
    try {
      return await task;
    } finally {
      // Resource work must finish before the deadline; Redis acknowledgements use the bounded drain.
      settled.resolve();
      resourceWork.delete(settled.promise);
    }
  }

  async function dispatchJobs() {
    try {
      while (!stopping.signal.aborted) {
        await recoverExpiredRuns(db);
        const [runIds, sessionIds] = await Promise.all([
          listQueuedRuns(db),
          deleteSessionResources ? listSessionDeletions(db) : [],
        ]);
        const executions = runIds.map((runId) => ({
          name: 'execute',
          data: { runId },
          opts: { jobId: runId },
        }));
        const deletions = sessionIds.map((sessionId) => ({
          name: 'delete-session',
          data: { sessionId },
          opts: { jobId: `delete-session-${sessionId}` },
        }));
        const jobs = [...executions, ...deletions];
        if (jobs.length > 0) await queue.addBulk(jobs);

        await waitInterval(1_000, undefined, { signal: stopping.signal });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'AbortError' &&
        error.cause === stopping.signal.reason
      )
        return;

      // Durable work survives; let the process supervisor restart failed infrastructure.
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

  async function closeWorker() {
    // Stop accepting work, then join SDK/sandbox cleanup before starting the queue I/O deadline.
    await worker.pause(true);
    await Promise.all(resourceWork);
    const deadline = AbortSignal.timeout(QUEUE_DRAIN_TIMEOUT_MS);
    using _deadline = addAbortListener(deadline, disconnectQueue);
    const [closed] = await Promise.allSettled([worker.close()]);
    if (deadline.aborted)
      throw new Error(
        `Agent Worker ${prefix} queue did not drain within ${QUEUE_DRAIN_TIMEOUT_MS}ms`,
        {
          cause: closed.status === 'rejected' ? closed.reason : deadline.reason,
        },
      );
    if (closed.status === 'fulfilled') return;
    if (closed.reason instanceof Error) throw closed.reason;

    throw new Error(`Agent Worker ${prefix} queue shutdown failed`, { cause: closed.reason });
  }

  function disconnectQueue() {
    // Both clients belong to this Worker; HTTP subscriptions and other workers remain connected.
    consumer.disconnect();
    progress.disconnect();
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
