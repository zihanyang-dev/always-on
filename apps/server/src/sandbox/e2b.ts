import type { ExecutionWorkspace, WorkspaceFileWrite } from '@always-on/agent-runtime/workspace';
import { NotFoundError, Sandbox, type SandboxConnectOpts } from 'e2b';
import { executeSandboxCommand } from './command.js';

/** The provider's working directory, independent of Runner-side SDK storage. */
export const SANDBOX_WORKING_DIRECTORY = '/home/user/workspace';
const MAX_FILE_READ_BYTES = 20 * 1_024 * 1_024;

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
  const fileOptions = signal ? { signal } : {};
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
  await sandbox.files.makeDir(directory, fileOptions);
  const resources = startup.move();
  return {
    sandboxId: sandbox.sandboxId,
    directory,
    readFile,
    checkFile,
    writeFile,
    createDirectory,
    executeCommand,
    [Symbol.asyncDispose]: resources.disposeAsync.bind(resources),
  };

  async function readFile(path: string) {
    const stream = await sandbox.files.read(path, { format: 'stream', ...fileOptions });
    const chunks: Uint8Array[] = [];
    let sizeBytes = 0;
    // Limit actual streamed bytes: guest files can grow after a metadata check.
    // Exiting async iteration cancels the SDK download and releases its connection.
    for await (const chunk of stream) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > MAX_FILE_READ_BYTES)
        throw new Error(`Sandbox file ${path} exceeds the 20 MiB read limit`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, sizeBytes);
  }

  async function checkFile(path: string) {
    await sandbox.files.getInfo(path, fileOptions);
  }

  async function writeFile({ path, content }: WorkspaceFileWrite) {
    await sandbox.files.write(path, content, fileOptions);
  }

  async function createDirectory(path: string) {
    await sandbox.files.makeDir(path, fileOptions);
  }

  async function executeCommand(input: Parameters<ExecutionWorkspace['executeCommand']>[0]) {
    const signals = [signal, input.signal].filter((candidate) => candidate !== undefined);
    return executeSandboxCommand(sandbox, {
      ...input,
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
    });
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
