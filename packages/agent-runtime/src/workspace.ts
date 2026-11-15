/** File and process capabilities of an authorized execution environment. */
export type ExecutionWorkspace = {
  readonly directory: string;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly checkFile: (path: string) => Promise<void>;
  readonly writeFile: (input: WorkspaceFileWrite) => Promise<void>;
  readonly createDirectory: (path: string) => Promise<void>;
  /** Rejects with signal.reason on cancellation only after remote termination is acknowledged. */
  readonly executeCommand: (input: {
    command: string;
    directory: string;
    timeoutSeconds?: number;
    signal?: AbortSignal;
    onOutput: (chunk: Buffer) => void;
  }) => Promise<{ exitCode: number | null }>;
};
/** Text or file-backed binary content delivered to the execution environment. */
export type WorkspaceFileWrite = {
  readonly path: string;
  readonly content: string | Blob;
};
