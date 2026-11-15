import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ExecutionContext } from '@always-on/agent-runtime/execution';
import { executePi, listPiModels } from '@always-on/agent-runtime/pi';
import type { ExecutionWorkspace } from '@always-on/agent-runtime/workspace';
import { MODEL_CATALOG_SCHEMA, type ModelCatalog } from '@always-on/contracts/models';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Database } from '../infrastructure/database/index.js';
import {
  openE2bWorkspace,
  SANDBOX_WORKING_DIRECTORY,
  SandboxNotFoundError,
} from '../sandbox/index.js';
import {
  authorizeRunTool,
  bindRunSandbox,
  createRunWorkspace,
  type RunClaim,
  type RunCompletion,
  type RunInterruption,
} from '../tasks/index.js';
import { readWorkspaceSummary } from '../workspaces/index.js';
import type { CloudAgentConfiguration } from './agent-config.js';

/** Reads provider capabilities through Pi and exposes only enabled public model metadata. */
export async function loadAgentModelCatalog(
  config: CloudAgentConfiguration,
): Promise<ModelCatalog> {
  const groups = await Promise.all(
    config.connections.map((connection) => {
      const identity = createHash('sha256').update(connection.provider).digest('hex');

      return listPiModels({ directory: join(config.directory, 'providers', identity), connection });
    }),
  );
  const models = groups.flat();
  const hasDefault = models.some(
    (model) =>
      model.provider === config.defaultModel.provider && model.id === config.defaultModel.id,
  );
  if (!hasDefault)
    throw new Error(
      `Default model ${config.defaultModel.provider}/${config.defaultModel.id} is unavailable`,
    );

  return MODEL_CATALOG_SCHEMA.parse({ models, defaultModel: config.defaultModel });
}

/** Binds the concrete cloud SDK, authorized product tool and independently owned E2B environment. */
export async function executeCloudRun({
  db,
  config,
  claim,
  context,
  createId,
  onError,
}: {
  db: Database;
  config: CloudAgentConfiguration;
  claim: RunClaim;
  context: ExecutionContext;
  createId: () => string;
  onError: (error: Error) => void;
}): Promise<RunCompletion> {
  const connection = config.connections.find(
    (candidate) => candidate.provider === claim.configuration.model.provider,
  );
  if (!connection)
    return {
      status: 'failed',
      error: `Run ${claim.run.id} selected an unavailable model provider`,
      checkpoint: null,
    };

  // Pi stays on the trusted Runner; only file and process capabilities cross into E2B.
  await using resources = new AsyncDisposableStack();
  const cancellation = new AbortController();
  const signals = [cancellation.signal, AbortSignal.timeout(300_000)];
  if (context.signal) signals.push(context.signal);

  const signal = AbortSignal.any(signals);
  let pendingWorkspace: Promise<ExecutionWorkspace> | undefined;
  let uncertainty: Error | undefined;
  let missingSandbox: SandboxNotFoundError | undefined;
  const workspace = createDeferredWorkspace(getWorkspace);
  const session = {
    directory: join(
      config.directory,
      'sessions',
      claim.run.sessionId,
      claim.run.id,
      claim.ownerToken,
    ),
    connection,
    modelId: claim.configuration.model.id,
    reasoningEffort: claim.configuration.reasoningEffort,
    systemPrompt: claim.configuration.instructions,
    tools: [createWorkspaceContextTool({ db, claim })],
    workspace,
    checkpoint: claim.checkpoint,
  };
  const result = await executePi({ text: claim.text, session }, { signal, emit: context.emit });
  // An unconfirmed external effect takes precedence over SDK success or cancellation.
  if (uncertainty)
    return {
      status: 'recovery_required',
      error: `Run ${claim.run.id} has an uncertain tool result`,
    };
  if (missingSandbox)
    return {
      status: 'failed',
      error: missingSandbox.message,
      checkpoint: 'checkpoint' in result ? result.checkpoint : null,
    };

  switch (result.status) {
    case 'completed':
    case 'cancelled':
      return { status: result.status, checkpoint: result.checkpoint };
    case 'failed':
      onError(
        new Error(`Run ${claim.run.id} model request failed`, { cause: new Error(result.message) }),
      );
      return {
        status: 'failed',
        error: `Run ${claim.run.id} model request failed`,
        checkpoint: result.checkpoint,
      };
    case 'incomplete':
      return { status: 'recovery_required', error: result.message };
    default: {
      const exhaustive: never = result;
      throw new Error(`Unexpected cloud execution result ${JSON.stringify(exhaustive)}`);
    }
  }

  function getWorkspace() {
    // Cache failures too: acquisition retries within one Run must not silently bind another VM.
    pendingWorkspace ??= prepareWorkspace();

    return pendingWorkspace;
  }

  async function prepareWorkspace() {
    const access = await authorizeRunTool({ db, claim });
    if (access.status === 'cancel_requested') {
      cancellation.abort();
      signal.throwIfAborted();
    }

    try {
      const metadata = {
        application: 'always-on',
        workspaceId: claim.workspaceId,
        sessionId: claim.run.sessionId,
      };
      const binding = claim.sandboxId
        ? { kind: 'existing' as const, sandboxId: claim.sandboxId }
        : {
            kind: 'new' as const,
            idempotencyKey: claim.run.sessionId,
            metadata,
          };
      const sandbox = resources.use(
        await openE2bWorkspace({ connection: config.sandbox, binding, signal }),
      );
      // Bind before starting an effect receipt: acquisition is distinct from command dispatch.
      await bindRunSandbox({ db, claim, sandboxId: sandbox.sandboxId });

      return createRunWorkspace({ db, claim, signal, createId, stop, workspace: sandbox });
    } catch (error) {
      // Replacing a missing binding would conceal the loss of the user's working files.
      if (error instanceof SandboxNotFoundError) missingSandbox = error;
      else
        uncertainty = new Error(`Run ${claim.run.id} could not confirm its sandbox binding`, {
          cause: error,
        });
      cancellation.abort(error);
      throw error;
    }
  }

  function stop(interruption: RunInterruption) {
    if (interruption.kind === 'cancel_requested') {
      cancellation.abort();

      return;
    }
    if (interruption.kind === 'uncertain_effect') uncertainty ??= interruption.error;

    onError(interruption.error);
    cancellation.abort(interruption.error);
  }
}

function createDeferredWorkspace(
  getSandbox: () => Promise<ExecutionWorkspace>,
): ExecutionWorkspace {
  // Text and product-only requests do not create a VM. Concurrent tools share one acquisition.
  return {
    directory: SANDBOX_WORKING_DIRECTORY,
    readFile: async (path) => (await getSandbox()).readFile(path),
    checkFile: async (path) => (await getSandbox()).checkFile(path),
    writeFile: async (input) => (await getSandbox()).writeFile(input),
    createDirectory: async (path) => (await getSandbox()).createDirectory(path),
    executeCommand: async (input) => (await getSandbox()).executeCommand(input),
  };
}

function createWorkspaceContextTool({ db, claim }: { db: Database; claim: RunClaim }) {
  return defineTool({
    name: 'get_workspace_context',
    label: 'Workspace context',
    description: 'Read the current human workspace identity and name.',
    parameters: Type.Object({}),
    execute: readContext,
  });

  async function readContext() {
    // Product tools need current authority even though they do not enter the user sandbox.
    const access = await authorizeRunTool({ db, claim });
    if (access.status === 'cancel_requested') throw new Error(`Run ${claim.run.id} was cancelled`);

    const workspace = await readWorkspaceSummary({
      db,
      workspaceId: claim.workspaceId,
      userId: claim.userId,
    });
    if (!workspace)
      throw new Error(`Run ${claim.run.id} cannot read workspace ${claim.workspaceId}`);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(workspace) }],
      details: undefined,
    };
  }
}
