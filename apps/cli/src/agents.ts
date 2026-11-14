import { discoverLocalAgents } from '@always-on/agent-runtime';
import type { CliResult, OutputFormat } from './command.js';

/** Detects local installations and formats their result without contacting the platform. */
export async function runAgentsCommand({
  searchPath,
  executableExtensions,
  platform,
  format,
  signal,
}: {
  searchPath: string;
  executableExtensions: readonly string[];
  platform: NodeJS.Platform;
  format: OutputFormat;
  signal?: AbortSignal;
}): Promise<CliResult> {
  const agents = await discoverLocalAgents({ searchPath, executableExtensions, platform, signal });
  if (format === 'json') return { output: JSON.stringify(agents, null, 2), exitCode: 0 };
  // Presence is reported honestly; finding a binary does not certify its execution protocol.
  const lines = agents.map(
    ({ agent, installation }) =>
      `${agent.name}: ${installation.status === 'found' ? installation.path : 'not installed'}`,
  );
  return { output: lines.join('\n'), exitCode: 0 };
}
