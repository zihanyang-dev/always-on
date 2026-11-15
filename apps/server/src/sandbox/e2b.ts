import type { ExecutionWorkspace, WorkspaceFileWrite } from '@always-on/agent-runtime/workspace';
import { NotFoundError, Sandbox, type SandboxConnectOpts } from 'e2b';
import { executeSandboxCommand } from './command.js';

/** The provider's working directory, independent of Runner-side SDK storage. */
export const SANDBOX_WORKING_DIRECTORY = '/home/user/workspace';

/** Connection settings shared by hosted E2B and the official self-hosted Embed stack. */
export type E2bConnection = {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly sandboxUrl?: string;
};

/** A session-owned VM; disposing it preserves the workspace by pausing the same sandbox. */
export interface SandboxWorkspace extends ExecutionWorkspace, AsyncDisposable {
  readonly sandboxId: string;
}

type SandboxBinding =
  | {
      readonly kind: 'new';
      readonly idempotencyKey: string;
      readonly metadata?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'existing'; readonly sandboxId: string };

/** A confirmed missing environment must not be replaced by an empty VM. */
export class SandboxNotFoundError extends Error {
  override name = 'SandboxNotFoundError';
  readonly sandboxId: string;

  constructor(sandboxId: string, options: ErrorOptions) {
    super(`Bound sandbox ${sandboxId} no longer exists`, options);
    this.sandboxId = sandboxId;
  }
}

/** Creates or reconnects the explicitly bound VM without replacing missing session state. */
export async function openE2bWorkspace({
  connection,
  binding,
  signal,
}: {
  connection: E2bConnection;
  binding: SandboxBinding;
  signal?: AbortSignal;
}): Promise<SandboxWorkspace> {
  signal?.throwIfAborted();
  const options = { ...connection, timeoutMs: 300_000, requestTimeoutMs: 60_000 };
  const sandbox =
    binding.kind === 'new'
      ? await Sandbox.create({
          ...options,
          template: 'base',
          idempotencyKey: binding.idempotencyKey,
          ...(binding.metadata ? { metadata: binding.metadata } : {}),
          lifecycle: { onTimeout: 'pause' },
        })
      : await connectBoundSandbox({ sandboxId: binding.sandboxId, options });
  // A cancelled acquisition still owns the VM; pause it before reporting cancellation.
  await using startup = new AsyncDisposableStack();
  startup.defer(dispose);
  signal?.throwIfAborted();
  const directory = SANDBOX_WORKING_DIRECTORY;
  await sandbox.files.makeDir(directory);
  const resources = startup.move();
  return {
    sandboxId: sandbox.sandboxId,
    directory,
    readFile,
    checkFile,
    writeFile,
    createDirectory,
    executeCommand: (input) => executeSandboxCommand(sandbox, input),
    [Symbol.asyncDispose]: resources.disposeAsync.bind(resources),
  };

  async function readFile(path: string) {
    return Buffer.from(await sandbox.files.read(path, { format: 'bytes' }));
  }

  async function checkFile(path: string) {
    await sandbox.files.getInfo(path);
  }

  async function writeFile({ path, content }: WorkspaceFileWrite) {
    await sandbox.files.write(path, content);
  }

  async function createDirectory(path: string) {
    await sandbox.files.makeDir(path);
  }

  async function dispose() {
    // Strict pause refuses an unhealthy guest instead of claiming its state was saved.
    await sandbox.pause({ strict: true });
  }
}

async function connectBoundSandbox({
  sandboxId,
  options,
}: {
  sandboxId: string;
  options: SandboxConnectOpts;
}) {
  try {
    return await Sandbox.connect(sandboxId, options);
  } catch (error) {
    if (error instanceof NotFoundError) throw new SandboxNotFoundError(sandboxId, { cause: error });
    throw error;
  }
}
