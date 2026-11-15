import { setTimeout as waitInterval } from 'node:timers/promises';
import type { ExecutionContext } from '@always-on/agent-runtime/execution';
import type { SessionEvent } from '@always-on/contracts/agents';
import type { Database } from '../infrastructure/database/index.js';
import { createRunOutput } from './output.js';
import { claimRun, type RunClaim, renewRun } from './ownership.js';
import { completeRun, type RunCompletion } from './store.js';

/** A concrete harness supplied by the composition root, without SDK state in the Worker. */
export type RunExecutor = (claim: RunClaim, context: ExecutionContext) => Promise<RunCompletion>;

/** Owns one claimed Run from admission through cleanup and fenced terminal commit. */
export async function executeQueuedRun({
  db,
  runId,
  ownerToken,
  execute,
  signal,
  publish,
  onError,
}: {
  db: Database;
  runId: string;
  ownerToken: string;
  execute: RunExecutor;
  signal: AbortSignal;
  publish: (input: { sessionId: string; event: SessionEvent }) => Promise<void>;
  onError: (error: Error) => void;
}): Promise<void> {
  if (signal.aborted) return;

  const claim = await claimRun({ db, runId, ownerToken });
  if (!claim) return;

  const { sessionId } = claim.run;
  const control = new RunControl({ db, claim, signal });
  const emit = createRunOutput({ db, claim, publish: publishEvent });
  let completion: RunCompletion;

  {
    await using _owner = control;

    try {
      await publishEvent({ type: 'run', run: claim.run });
      completion = await execute(claim, { signal: control.signal, emit });
    } catch (error) {
      onError(new Error(`Run ${runId} execution failed`, { cause: error }));
      completion = {
        status: 'recovery_required',
        error: `Run ${runId} did not reach a confirmed execution boundary`,
      };
    }
  }

  const failure = control.getFailure();
  if (failure) {
    onError(failure);
    completion = { status: 'recovery_required', error: `Run ${runId} lost its execution lease` };
  }

  const run = await completeRun({ db, claim, completion });
  await publishEvent({ type: 'run', run });

  function publishEvent(event: SessionEvent) {
    return publish({ sessionId, event });
  }
}

/** Keeps ownership alive through SDK abort and Sandbox cleanup, including user cancellation. */
class RunControl implements AsyncDisposable {
  readonly signal: AbortSignal;
  readonly #lifetime = new AbortController();
  readonly #execution = new AbortController();
  readonly #db: Database;
  readonly #claim: RunClaim;
  readonly #polling: Promise<void>;
  #failure: Error | undefined;

  constructor({ db, claim, signal }: { db: Database; claim: RunClaim; signal: AbortSignal }) {
    this.#db = db;
    this.#claim = claim;
    this.signal = AbortSignal.any([signal, this.#execution.signal]);
    this.#polling = this.#observeOwnership();
  }

  getFailure() {
    return this.#failure;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#lifetime.abort();
    await this.#polling;
  }

  async #observeOwnership() {
    try {
      while (!this.#lifetime.signal.aborted) {
        const status = await renewRun({ db: this.#db, claim: this.#claim });
        if (status === 'lost')
          throw new Error(`Run ${this.#claim.run.id} execution lease was lost`);
        if (status === 'cancel_requested') this.#execution.abort();

        await waitInterval(1_000, undefined, { signal: this.#lifetime.signal });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'AbortError' &&
        error.cause === this.#lifetime.signal.reason
      )
        return;

      this.#failure = new Error(`Run ${this.#claim.run.id} ownership check failed`, {
        cause: error,
      });
      this.#execution.abort(this.#failure);
    }
  }
}
