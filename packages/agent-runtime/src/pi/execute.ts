import { addAbortListener } from 'node:events';
import { access } from 'node:fs/promises';
import { WritableStream, type WritableStreamDefaultWriter } from 'node:stream/web';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ExecutionContext, ExecutionEvent } from '../execution.js';
import { createPiCheckpoint, type PiCheckpoint } from './checkpoint.js';
import { createSessionObserver } from './events.js';
import { openPiSession, type PiSession, type PiSessionOptions } from './session.js';

const MAX_PENDING_EVENTS = 1_024;

/** One literal input and the native conversation to create or restore. */
export type PiExecutionRequest = { readonly text: string; readonly session: PiSessionOptions };

/** SDK outcomes; storage, delivery and lifecycle failures reject the execution instead. */
export type PiExecutionResult =
  | { readonly status: 'completed'; readonly text: string; readonly checkpoint: PiCheckpoint }
  | { readonly status: 'cancelled'; readonly checkpoint: PiCheckpoint | null }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly checkpoint: PiCheckpoint | null;
    }
  | { readonly status: 'incomplete'; readonly message: string };

/** Executes one input, joining SDK work and acknowledged output before interpreting its result. */
export async function executePi(
  request: PiExecutionRequest,
  context: ExecutionContext,
): Promise<PiExecutionResult> {
  if (context.signal?.aborted) return { status: 'cancelled', checkpoint: null };

  await using conversation = await openPiSession(request.session);
  if (context.signal?.aborted) return { status: 'cancelled', checkpoint: null };

  const execution = new PiExecutionResources(conversation.sdk, context);
  let outcome: PromiseSettledResult<void>;
  {
    await using _resources = execution;
    // Product input cannot invoke deployment-local commands or prompt templates.
    [outcome] = await Promise.allSettled([
      conversation.sdk.prompt(request.text, { expandPromptTemplates: false }),
    ]);
  }
  const failure = execution.getFailure(outcome);
  if (failure)
    throw new Error(`Pi session ${conversation.sdk.sessionId} execution failed`, {
      cause: failure,
    });
  if (context.signal?.aborted)
    return { status: 'cancelled', checkpoint: await readCheckpointFile(conversation.sessionFile) };

  return getPiResult(conversation);
}

/** Owns subscriptions, ordered event acknowledgements and cancellation for the same SDK run. */
class PiExecutionResources implements AsyncDisposable {
  readonly #sdk: AgentSession;
  readonly #writer: WritableStreamDefaultWriter<ExecutionEvent>;
  readonly #unsubscribe: () => void;
  readonly #cancellation: ReturnType<typeof addAbortListener> | undefined;
  readonly #notifications = new Map<ExecutionEvent, Promise<void>>();
  readonly #failures = new Set<Error>();
  #stopping: Promise<void> | undefined;

  constructor(sdk: AgentSession, context: ExecutionContext) {
    this.#sdk = sdk;
    this.#writer = new WritableStream<ExecutionEvent>({ write: context.emit }).getWriter();
    this.#unsubscribe = sdk.subscribe(createSessionObserver(this.#enqueue));
    this.#cancellation = context.signal
      ? addAbortListener(context.signal, this.#requestStop)
      : undefined;
  }

  getFailure(outcome: PromiseSettledResult<void>): Error | undefined {
    const failures = new Set(this.#failures);
    if (outcome.status === 'rejected') failures.add(getExecutionError(outcome.reason));

    const [first] = failures;
    if (failures.size < 2) return first;

    return new AggregateError(failures, `Pi session ${this.#sdk.sessionId} failed`, {
      cause: first,
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    using _cancellation = this.#cancellation;
    this.#unsubscribe();
    await Promise.all(this.#notifications.values());
    await this.#stopping;

    try {
      if (this.#failures.size > 0) {
        await this.#writer.abort();

        return;
      }

      await this.#writer.close();
    } catch (error) {
      this.#failures.add(getExecutionError(error));
    } finally {
      this.#writer.releaseLock();
    }
  }

  #enqueue = (event: ExecutionEvent) => {
    if (this.#failures.size > 0) return;
    if (this.#notifications.size >= MAX_PENDING_EVENTS) {
      this.#failures.add(
        new Error(`Pi session ${this.#sdk.sessionId} exceeded its output backlog`),
      );
      this.#requestStop();

      return;
    }

    // Pi does not await subscribers; retain every delivery until the receiver acknowledges it.
    const notification = this.#deliver(event);
    this.#notifications.set(event, notification);
    void notification;
  };

  async #deliver(event: ExecutionEvent) {
    try {
      await this.#writer.write(event);
    } catch (error) {
      this.#failures.add(getExecutionError(error));
      this.#requestStop();
    } finally {
      this.#notifications.delete(event);
    }
  }

  #requestStop = () => {
    this.#stopping ??= this.#stopSdk();
    void this.#stopping;
  };

  async #stopSdk() {
    try {
      await this.#sdk.abort();
    } catch (error) {
      this.#failures.add(getExecutionError(error));
    }
  }
}

async function getPiResult({ sdk, sessionFile }: PiSession): Promise<PiExecutionResult> {
  const assistant = sdk.messages.at(-1);
  if (assistant?.role !== 'assistant')
    return {
      status: 'incomplete',
      message: `Pi session ${sdk.sessionId} produced no assistant result`,
    };

  switch (assistant.stopReason) {
    case 'stop':
      return {
        status: 'completed',
        text: sdk.getLastAssistantText() ?? '',
        checkpoint: createPiCheckpoint(sessionFile),
      };
    case 'error':
    case 'aborted':
      return {
        status: 'failed',
        message: assistant.errorMessage ?? `Pi session ${sdk.sessionId} stopped`,
        checkpoint: await readCheckpointFile(sessionFile),
      };
    case 'length':
    case 'toolUse':
    case 'pending':
    case 'deferred':
      return {
        status: 'incomplete',
        message: `Pi session ${sdk.sessionId} ended at an unsettled ${assistant.stopReason} boundary`,
      };
    default: {
      const exhaustive: never = assistant.stopReason;
      throw new Error(`Unexpected Pi stop reason: ${exhaustive}`);
    }
  }
}

async function readCheckpointFile(sessionFile: string) {
  try {
    await access(sessionFile);

    return createPiCheckpoint(sessionFile);
  } catch (error) {
    // Pi delays its first file write; cancellation before a response may leave no checkpoint.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;

    throw error;
  }
}

function getExecutionError(error: unknown) {
  if (error instanceof Error) return error;

  return new Error('Pi execution rejected with a non-Error value', { cause: error });
}
