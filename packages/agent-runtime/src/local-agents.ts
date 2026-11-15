import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const LOCAL_AGENT_DEFINITIONS = [
  { id: 'pi', name: 'Pi', command: 'pi' },
  { id: 'codex', name: 'Codex', command: 'codex' },
  { id: 'claude-code', name: 'Claude Code', command: 'claude' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode' },
] as const;

/** A known CLI identity; detection does not imply execution-protocol support. */
export type LocalAgentDefinition = (typeof LOCAL_AGENT_DEFINITIONS)[number];
/** The presence of a command on the supplied search path. */
export type LocalAgentInstallation = {
  agent: LocalAgentDefinition;
  installation: { status: 'found'; path: string } | { status: 'missing' };
};

/** Detects installed CLIs without executing them or reading their credentials. */
export async function discoverLocalAgents({
  searchPath,
  platform,
  executableExtensions,
  signal,
}: {
  searchPath: string;
  platform: NodeJS.Platform;
  executableExtensions: readonly string[];
  signal?: AbortSignal | undefined;
}): Promise<readonly LocalAgentInstallation[]> {
  signal?.throwIfAborted();
  const separator = platform === 'win32' ? ';' : delimiter;
  // Empty PATH segments must not implicitly add the current working directory.
  const directories = searchPath.split(separator).filter((directory) => directory.length > 0);
  const suffixes = platform === 'win32' ? executableExtensions : [''];

  // Agent installations are independent; candidates for each Agent remain ordered.
  return await Promise.all(LOCAL_AGENT_DEFINITIONS.map(discoverAgent));

  async function discoverAgent(agent: LocalAgentDefinition): Promise<LocalAgentInstallation> {
    const candidates = getExecutableCandidates({ command: agent.command, directories, suffixes });
    const commandPath = await findExecutablePath({ candidates, platform, signal });
    if (!commandPath) return { agent, installation: { status: 'missing' } };

    return { agent, installation: { status: 'found', path: commandPath } };
  }
}

function getExecutableCandidates({
  command,
  directories,
  suffixes,
}: {
  command: string;
  directories: readonly string[];
  suffixes: readonly string[];
}) {
  const commandNames = suffixes.map((suffix) => `${command}${suffix}`);

  // Directory order wins before extension order, matching the supplied PATH.
  return directories.flatMap((directory) => commandNames.map((name) => join(directory, name)));
}

async function findExecutablePath({
  candidates,
  platform,
  signal,
}: {
  candidates: readonly string[];
  platform: NodeJS.Platform;
  signal: AbortSignal | undefined;
}) {
  // Stop at the first match instead of probing later PATH entries unnecessarily.
  for (const commandPath of candidates) {
    signal?.throwIfAborted();
    const canExecute = await isExecutable({ commandPath, platform });
    // stat/access cannot be interrupted, so cancellation is checked after the probe too.
    signal?.throwIfAborted();
    if (canExecute) return commandPath;
  }

  return undefined;
}

async function isExecutable({
  commandPath,
  platform,
}: {
  commandPath: string;
  platform: NodeJS.Platform;
}) {
  try {
    const entry = await stat(commandPath);
    if (!entry.isFile()) return false;

    await access(commandPath, platform === 'win32' ? constants.F_OK : constants.X_OK);

    return true;
  } catch (error) {
    // Missing or inaccessible candidates are normal during discovery; other I/O failures matter.
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      ['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)
    )
      return false;

    throw new Error(`Cannot inspect Agent command ${commandPath}`, {
      cause: error,
    });
  }
}
