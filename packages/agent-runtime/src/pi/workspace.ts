import { openAsBlob } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, posix } from 'node:path';
import {
  type AgentToolResult,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { ExecutionWorkspace } from '../workspace.js';

/** Keeps Pi's tool semantics while replacing every enabled filesystem and shell operation. */
export function createWorkspaceTools(workspace: ExecutionWorkspace): ToolDefinition[] {
  const { directory, readFile, checkFile, createDirectory } = workspace;
  const operations = {
    readFile,
    access: checkFile,
    writeFile: (path: string, content: string) => workspace.writeFile({ path, content }),
    mkdir: createDirectory,
  };
  const shell = createBashToolDefinition(directory, {
    // Runner credentials and session-local variables never become remote shell environment.
    exposeSessionEnvironment: false,
    operations: {
      exec: (command, cwd, options) =>
        workspace.executeCommand({
          command,
          directory: cwd,
          onOutput: options.onData,
          ...(options.timeout === undefined ? {} : { timeoutSeconds: options.timeout }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
    },
  });
  return [
    defineTool(createReadToolDefinition(directory, { operations })),
    defineTool(createWriteToolDefinition(directory, { operations })),
    defineTool(createEditToolDefinition(directory, { operations })),
    defineTool({ ...shell, execute: executeShell }),
  ];

  async function executeShell(...input: Parameters<typeof shell.execute>) {
    const result = await shell.execute(...input);
    const outputPath = result.details?.fullOutputPath;
    if (!outputPath) return result;
    const outputDirectory = posix.join(directory, '.agent-outputs');
    const remotePath = posix.join(outputDirectory, basename(outputPath));
    await using output = new AsyncDisposableStack();
    output.defer(() => rm(outputPath));
    // Pi owns truncation and formatting; move its completed spill before exposing the result.
    // A file-backed Blob keeps large stdout transfers out of the Runner's JavaScript heap.
    await workspace.createDirectory(outputDirectory);
    await workspace.writeFile({ path: remotePath, content: await openAsBlob(outputPath) });
    const content = result.content.map((part) =>
      part.type === 'text' ? { ...part, text: part.text.replaceAll(outputPath, remotePath) } : part,
    );
    return {
      ...result,
      content,
      details: { ...result.details, fullOutputPath: remotePath },
      ...(result.structuredContent === undefined
        ? {}
        : {
            structuredContent: replaceOutputPath(result.structuredContent, {
              outputPath,
              remotePath,
            }),
          }),
    };
  }
}

type StructuredContent = Exclude<AgentToolResult<unknown>['structuredContent'], undefined>;

function replaceOutputPath(
  content: StructuredContent,
  paths: { outputPath: string; remotePath: string },
): StructuredContent {
  if (!content || typeof content !== 'object' || !('full_output_path' in content)) return content;
  if (content.full_output_path !== paths.outputPath) return content;
  return { ...content, full_output_path: paths.remotePath };
}
