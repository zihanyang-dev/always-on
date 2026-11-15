import { constants } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  createAgentSession,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { ExecutionWorkspace } from '../workspace.js';
import { parsePiCheckpoint } from './checkpoint.js';
import { type ModelConnection, openPiClient } from './client.js';
import { createSessionResources } from './resources.js';
import { createWorkspaceTools } from './workspace.js';

/** Explicit configuration for one SDK session; all tools are supplied by the host. */
export type PiSessionOptions = {
  readonly directory: string;
  readonly connection: ModelConnection;
  readonly modelId: string;
  readonly reasoningEffort: string;
  readonly systemPrompt: string;
  readonly tools: ToolDefinition[];
  readonly checkpoint?: unknown;
  readonly workspace?: ExecutionWorkspace;
};

/** Private SDK resources used only by the Pi execution entry. */
export interface PiSession extends AsyncDisposable {
  readonly sdk: AgentSession;
  readonly sessionFile: string;
}

/** Opens native history and releases partially assembled resources if startup fails. */
export async function openPiSession(options: PiSessionOptions): Promise<PiSession> {
  await using startup = new AsyncDisposableStack();
  const { directory, connection, systemPrompt } = options;
  const checkpoint = parsePiCheckpoint(options.checkpoint);
  const sessionFile = checkpoint?.sessionFile;
  const client = startup.use(await openPiClient({ directory, connection }));
  const model = client.runtime.getModel(connection.provider, options.modelId);
  if (!model) throw new Error(`Pi model ${connection.provider}/${options.modelId} is unavailable`);

  const thinkingLevel = getSupportedThinkingLevels(model).find(
    (level) => level === options.reasoningEffort,
  );
  // Reject unsupported choices instead of letting the SDK silently clamp a user's preference.
  if (!thinkingLevel)
    throw new Error(
      `Model ${connection.provider}/${options.modelId} does not support reasoning effort ${options.reasoningEffort}`,
    );

  const workingDirectory = options.workspace?.directory ?? directory;
  const history = await openSessionHistory({ directory, workingDirectory, sessionFile });
  const workspaceTools = options.workspace ? createWorkspaceTools(options.workspace) : [];
  const tools = [...workspaceTools, ...options.tools];
  const { session } = await createAgentSession({
    // Pi passes its session cwd to tools; it must name the remote workspace, not the state store.
    cwd: workingDirectory,
    agentDir: directory,
    modelRuntime: client.runtime,
    model,
    thinkingLevel,
    tools: tools.map((tool) => tool.name),
    customTools: tools,
    resourceLoader: createSessionResources(systemPrompt),
    sessionManager: history,
    settingsManager: SettingsManager.inMemory({}),
  });
  startup.defer(closeSession);
  const historyFile = history.getSessionFile();
  if (!historyFile) throw new Error(`Pi session ${history.getSessionId()} has no persistent file`);

  const resources = startup.move();

  return {
    sdk: session,
    sessionFile: historyFile,
    [Symbol.asyncDispose]: resources.disposeAsync.bind(resources),
  };

  async function closeSession() {
    // Join asynchronous SDK work before its synchronous disposal; provider resources close last.
    try {
      await session.abort();
    } finally {
      session.dispose();
    }
  }
}

async function openSessionHistory({
  directory,
  workingDirectory,
  sessionFile,
}: {
  directory: string;
  workingDirectory: string;
  sessionFile: string | undefined;
}) {
  const historyDirectory = join(directory, 'sessions');
  if (!sessionFile) return SessionManager.create(workingDirectory, historyDirectory);

  // A Run receives its own transcript copy; an old owner must never mutate a committed checkpoint.
  // Copy opaque SDK bytes instead of reconstructing context from product display messages.
  await mkdir(historyDirectory, { recursive: true, mode: 0o700 });
  const restoredFile = join(historyDirectory, 'restored.jsonl');
  await copyFile(sessionFile, restoredFile, constants.COPYFILE_EXCL);
  const history = SessionManager.open(restoredFile, historyDirectory, workingDirectory);
  if (history.getEntries().length === 0)
    throw new Error(`Pi session file ${sessionFile} contains no recoverable history`);

  return history;
}
