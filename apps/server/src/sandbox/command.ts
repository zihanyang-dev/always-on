import { addAbortListener } from 'node:events';
import type { ExecutionWorkspace } from '@always-on/agent-runtime/workspace';
import { CommandExitError, type CommandHandle, type Sandbox } from 'e2b';

type CommandInput = Parameters<ExecutionWorkspace['executeCommand']>[0];
type CommandOutcome = PromiseSettledResult<{ exitCode: number }>;

/** Waits for remote exit, including cancellation, before releasing the command subscription. */
export async function executeSandboxCommand(
  sandbox: Sandbox,
  input: CommandInput,
): Promise<{ exitCode: number | null }> {
  input.signal?.throwIfAborted();
  // Cancelling transport during launch can lose the PID of an already running command.
  // Obtain the handle first; the resource immediately observes an intervening cancellation.
  const handle = await sandbox.commands.run(input.command, {
    background: true,
    // E2B's kill API targets one PID. A dedicated session lets cancellation stop its children too.
    shell: ['/usr/bin/setsid', '/bin/bash', '-c'],
    cwd: input.directory,
    timeoutMs: (input.timeoutSeconds ?? 60) * 1_000,
    retainOutput: false,
    onStdout: deliverOutput,
    onStderr: deliverOutput,
  });
  const execution = new E2bCommand({ sandbox, handle, signal: input.signal });
  let outcome: CommandOutcome;
  {
    await using _command = execution;
    [outcome] = await Promise.allSettled([execution.wait()]);
  }

  return execution.getResult(outcome);

  function deliverOutput(text: string) {
    input.onOutput(Buffer.from(text));
  }
}

/** Owns the remote process, abort listener and acknowledged kill for one command. */
class E2bCommand implements AsyncDisposable {
  readonly #sandbox: Sandbox;
  readonly #handle: CommandHandle<undefined>;
  readonly #signal: AbortSignal | undefined;
  readonly #cancellation: ReturnType<typeof addAbortListener> | undefined;
  #hasExited = false;
  #stopping: Promise<void> | undefined;
  #stopError: Error | undefined;

  constructor({
    sandbox,
    handle,
    signal,
  }: {
    sandbox: Sandbox;
    handle: CommandHandle<undefined>;
    signal: AbortSignal | undefined;
  }) {
    this.#sandbox = sandbox;
    this.#handle = handle;
    this.#signal = signal;
    this.#cancellation = signal ? addAbortListener(signal, this.#requestStop) : undefined;
  }

  async wait() {
    try {
      const result = await this.#handle.wait();
      this.#hasExited = true;

      return { exitCode: result.exitCode };
    } catch (error) {
      // A nonzero exit is still an acknowledged process exit, not a transport failure.
      if (error instanceof CommandExitError) this.#hasExited = true;

      throw error;
    }
  }

  getResult(outcome: CommandOutcome) {
    const failure = outcome.status === 'rejected' ? getCommandFailure(outcome.reason) : undefined;
    if (failure && this.#stopError)
      throw new AggregateError(
        [failure, this.#stopError],
        'Sandbox command and termination failed',
      );
    if (this.#stopError) throw this.#stopError;
    if (failure) throw failure;

    this.#signal?.throwIfAborted();
    if (outcome.status === 'fulfilled') return outcome.value;
    if (outcome.reason instanceof CommandExitError) return { exitCode: outcome.reason.exitCode };

    throw new Error('Sandbox command has no exit result');
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#cancellation?.[Symbol.dispose]();
    // Losing the event stream does not mean the command stopped running in the VM.
    if (!this.#hasExited) this.#requestStop();

    await this.#stopping;
  }

  #requestStop = () => {
    this.#stopping ??= this.#stop();
    void this.#stopping;
  };

  async #stop() {
    try {
      await this.#sandbox.commands.run(`kill -KILL -- -${this.#handle.pid}`, {
        timeoutMs: 5_000,
      });
    } catch (error) {
      this.#stopError = new Error(`Failed to terminate sandbox command ${this.#handle.pid}`, {
        cause: error,
      });
      // A failed group operation is uncertain, even if the SDK can still stop the parent.
      const [cleanup] = await Promise.allSettled([this.#handle.kill()]);
      if (cleanup.status === 'rejected')
        this.#stopError = new AggregateError(
          [this.#stopError, cleanup.reason],
          `Sandbox command ${this.#handle.pid} termination and cleanup failed`,
        );
    }
  }
}

function getCommandFailure(error: unknown) {
  if (error instanceof CommandExitError) return undefined;
  if (error instanceof Error) return error;

  return new Error('Sandbox command transport failed', { cause: error });
}
