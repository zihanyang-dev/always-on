import type { ExecutionWorkspace } from '@always-on/agent-runtime/workspace';
import type { Database } from '../infrastructure/database/index.js';
import type { RunClaim } from './ownership.js';
import { authorizeRunTool, finishRunTool, type RunToolAccess, startRunTool } from './store.js';

/** Distinguishes rejected access from an external action whose result cannot be trusted. */
export type RunInterruption =
  | { readonly kind: 'cancel_requested' }
  | { readonly kind: 'authorization' | 'uncertain_effect'; readonly error: Error };

/** Adds current authorization and durable side-effect receipts to an execution capability. */
export function createRunWorkspace({
  workspace,
  db,
  claim,
  signal,
  createId,
  stop,
}: {
  workspace: ExecutionWorkspace;
  db: Database;
  claim: RunClaim;
  signal: AbortSignal;
  createId: () => string;
  stop: (interruption: RunInterruption) => void;
}): ExecutionWorkspace {
  return {
    directory: workspace.directory,
    readFile,
    checkFile,
    writeFile: (input) => recordEffect('write_file', () => workspace.writeFile(input)),
    createDirectory: (path) =>
      recordEffect('create_directory', () => workspace.createDirectory(path)),
    executeCommand,
  };

  async function readFile(path: string) {
    await authorize();
    return workspace.readFile(path);
  }

  async function checkFile(path: string) {
    await authorize();
    await workspace.checkFile(path);
  }

  async function executeCommand(input: Parameters<ExecutionWorkspace['executeCommand']>[0]) {
    const commandSignal = input.signal ? AbortSignal.any([signal, input.signal]) : signal;
    return recordEffect(
      'bash',
      () => workspace.executeCommand({ ...input, signal: commandSignal }),
      commandSignal,
    );
  }

  async function authorize() {
    await checkToolAuthority(() => authorizeRunTool({ db, claim }));
  }

  async function recordEffect<TResult>(
    name: string,
    operation: () => Promise<TResult>,
    operationSignal = signal,
  ) {
    operationSignal.throwIfAborted();
    const toolId = createId();
    await checkToolAuthority(() => startRunTool({ db, claim, tool: { id: toolId, name } }));
    try {
      const result = await operation();
      await finishRunTool({ db, claim, toolId });
      return result;
    } catch (error) {
      // The command adapter throws the exact abort reason only after remote termination is confirmed.
      if (operationSignal.aborted && error === operationSignal.reason) {
        await finishRunTool({ db, claim, toolId });
        throw error;
      }
      // An unacknowledged effect stays pending and prevents automatic replay of this Session.
      stop({
        kind: 'uncertain_effect',
        error: new Error(`Run ${claim.run.id} tool ${toolId} has an uncertain result`, {
          cause: error,
        }),
      });
      throw error;
    }
  }

  async function checkToolAuthority(check: () => Promise<RunToolAccess>) {
    signal.throwIfAborted();
    let access: RunToolAccess;
    try {
      access = await check();
    } catch (error) {
      stop({
        kind: 'authorization',
        error: new Error(`Run ${claim.run.id} tool authorization failed`, { cause: error }),
      });
      throw error;
    }
    if (access.status === 'allowed') return;
    stop({ kind: 'cancel_requested' });
    throw new Error(`Run ${claim.run.id} tool execution was cancelled`);
  }
}
