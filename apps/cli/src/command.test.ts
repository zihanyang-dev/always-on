import { describe, expect, it } from 'vitest';
import { parseCliCommand } from './command.js';

describe('CLI input', () => {
  it('defaults to help and recognizes command-specific options', () => {
    expect(parseCliCommand([])).toEqual({ kind: 'help' });
    expect(parseCliCommand(['agents', '--json'])).toEqual({ kind: 'agents', format: 'json' });
    expect(parseCliCommand(['status', '--server', 'https://platform.example'])).toEqual({
      kind: 'status',
      format: 'text',
      serverUrl: 'https://platform.example',
    });
  });

  it('rejects unknown commands, extra positionals, and irrelevant options', () => {
    expect(() => parseCliCommand(['missing'])).toThrow('Unknown command missing');
    expect(() => parseCliCommand(['agents', 'extra'])).toThrow('Expected one command');
    expect(() => parseCliCommand(['agents', '--server', 'https://platform.example'])).toThrow(
      '--server is only available for status',
    );
  });
});
