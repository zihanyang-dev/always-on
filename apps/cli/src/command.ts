import { parseArgs } from 'node:util';

/** Output representation selected at the CLI input boundary. */
export type OutputFormat = 'text' | 'json';

/** Only status commands may carry a platform URL. */
export type CliCommand =
  | { kind: 'help' }
  | { kind: 'agents'; format: OutputFormat }
  | { kind: 'status'; format: OutputFormat; serverUrl: string | undefined };

/** Command output and exit status, applied together by the process entry point. */
export type CliResult = { output: string; exitCode: 0 | 1 };

/** Usage for the commands that are actually available in this scaffold. */
export const CLI_HELP_TEXT = `Always On CLI

  always-on status [--server URL] [--json]   Check platform readiness
  always-on agents [--json]                Detect installed Agent CLIs

Connection and execution commands are not enabled in this scaffold.`;

/** Parses command-specific input without loading configuration or starting I/O. */
export function parseCliCommand(args: readonly string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      server: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [name = 'help'] = positionals;
  // Help must remain usable even when saved configuration is broken.
  if (values.help || name === 'help') return { kind: 'help' };
  if (positionals.length > 1) throw new Error('Expected one command: status or agents');

  const format = values.json ? 'json' : 'text';

  switch (name) {
    case 'agents':
      if (values.server !== undefined) throw new Error('--server is only available for status');
      return { kind: 'agents', format };
    case 'status':
      return { kind: 'status', format, serverUrl: values.server };
    default:
      throw new Error(`Unknown command ${name}. Available commands: status, agents`);
  }
}
