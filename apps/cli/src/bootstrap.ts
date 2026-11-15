#!/usr/bin/env node
import { homedir } from 'node:os';
import { runAgentsCommand } from './agents.js';
import { CLI_HELP_TEXT, type CliCommand, type CliResult, parseCliCommand } from './command.js';
import { loadCliConfig, parseAgentSearchEnv } from './config.js';
import { runStatusCommand } from './status.js';

try {
  const command = parseCliCommand(process.argv.slice(2));
  const result = await executeCommand(command);
  console.log(result.output);
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'CLI command failed');
  process.exitCode = 1;
}

async function executeCommand(command: CliCommand): Promise<CliResult> {
  switch (command.kind) {
    case 'help':
      return { output: CLI_HELP_TEXT, exitCode: 0 };
    case 'agents':
      // Local discovery must not depend on platform preferences or connectivity.
      return await runAgentsCommand({
        ...parseAgentSearchEnv(process.env),
        platform: process.platform,
        format: command.format,
      });
    case 'status': {
      const config = await loadCliConfig({
        environment: process.env,
        serverUrl: command.serverUrl,
        homeDirectory: homedir(),
        platform: process.platform,
      });

      return await runStatusCommand({ serverUrl: config.serverUrl, format: command.format });
    }
    default: {
      const exhaustive: never = command;
      throw new Error(`Unsupported command ${JSON.stringify(exhaustive)}`);
    }
  }
}
