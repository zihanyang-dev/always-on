import { z } from 'zod';
import { MODEL_REFERENCE_SCHEMA, type ModelReference } from './models.js';

/** Execution settings copied into each admitted Run. */
export type AgentConfiguration = {
  readonly model: ModelReference;
  readonly reasoningEffort: string;
  readonly instructions: string;
};

/** Resolved Agent settings, excluding credentials and deployment paths. */
export interface CreateAgent extends AgentConfiguration {
  readonly workspaceId: string;
  readonly name: string;
  readonly visibility: 'private' | 'workspace';
}

/** An Agent definition owned by a workspace and its creator. */
export interface Agent extends CreateAgent {
  readonly id: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** A private conversation with its current defaults for subsequent Runs. */
export type AgentSession = {
  readonly id: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly configuration: AgentConfiguration;
  readonly revision: number;
  readonly createdAt: string;
};

type RunIdentity = {
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: string;
};
interface QueuedRun extends RunIdentity {
  readonly status: 'queued';
}
interface ActiveRun extends RunIdentity {
  readonly status: 'running' | 'cancelling';
  readonly startedAt: string;
}
interface FinishedRun extends RunIdentity {
  readonly status: 'completed' | 'cancelled';
  readonly finishedAt: string;
}
interface FailedRun extends RunIdentity {
  readonly status: 'failed' | 'recovery_required';
  readonly finishedAt: string;
  readonly error: string;
}

/** One admitted execution, including explicit uncertain recovery. */
export type AgentRun = QueuedRun | ActiveRun | FinishedRun | FailedRun;

/** An execution whose ownership has been established by the platform. */
export type ActiveAgentRun = Extract<AgentRun, { status: 'running' | 'cancelling' }>;

/** Display content and its confirmation state, separate from the executor's original context. */
export type AgentMessage = {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly state: 'pending' | 'completed' | 'interrupted';
  readonly text: string;
  readonly position: number;
};

/** The authoritative display view for initial loading and stream resynchronization. */
export type SessionSnapshot = {
  readonly session: AgentSession;
  readonly run: AgentRun | null;
  readonly messages: readonly AgentMessage[];
};

/** Full message replacements make replay idempotent across refreshes and reconnects. */
export type SessionEvent =
  | { readonly type: 'message'; readonly message: AgentMessage }
  | { readonly type: 'run'; readonly run: AgentRun }
  | {
      readonly type: 'tool';
      readonly runId: string;
      readonly id: string;
      readonly name: string;
      readonly state: 'running' | 'completed' | 'failed';
    };

const INSTRUCTIONS_SCHEMA = z.string().trim().min(1).max(32_000);
const AGENT_SETTINGS_SCHEMA = z.strictObject({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  instructions: INSTRUCTIONS_SCHEMA,
  model: MODEL_REFERENCE_SCHEMA,
  reasoningEffort: z.string().trim().min(1).max(32),
  visibility: z.enum(['private', 'workspace']).default('private'),
});
const RUN_IDENTITY_SCHEMA = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  createdAt: z.iso.datetime(),
});

/** Validates execution settings at storage boundaries. */
export const AGENT_CONFIGURATION_SCHEMA: z.ZodType<AgentConfiguration> = z.strictObject({
  model: MODEL_REFERENCE_SCHEMA,
  reasoningEffort: z.string().trim().min(1).max(32),
  instructions: INSTRUCTIONS_SCHEMA,
});

/** Parses Agent creation and resolves documented defaults. */
export const CREATE_AGENT_SCHEMA: z.ZodType<CreateAgent> = AGENT_SETTINGS_SCHEMA;

/** Validates a saved Agent definition. */
export const AGENT_SCHEMA: z.ZodType<Agent> = AGENT_SETTINGS_SCHEMA.extend({
  id: z.uuid(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});

/** Starts a conversation against a saved Agent definition. */
export const CREATE_SESSION_SCHEMA: z.ZodType<{ agentId: string }> = z.strictObject({
  agentId: z.uuid(),
});

/** Validates a conversation view without exposing native storage references. */
export const AGENT_SESSION_SCHEMA: z.ZodType<AgentSession> = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  workspaceId: z.string(),
  createdBy: z.string(),
  configuration: AGENT_CONFIGURATION_SCHEMA,
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

/** A stable source identity makes an acknowledged submission safe to retry. */
export const SUBMIT_MESSAGE_SCHEMA: z.ZodType<{ sourceEventId: string; text: string }> =
  z.strictObject({
    sourceEventId: z.string().min(1).max(500),
    text: z.string().trim().min(1).max(64_000),
  });

/** Rejects execution states with missing completion or failure facts. */
export const AGENT_RUN_SCHEMA: z.ZodType<AgentRun> = z.discriminatedUnion('status', [
  RUN_IDENTITY_SCHEMA.extend({ status: z.literal('queued') }),
  RUN_IDENTITY_SCHEMA.extend({
    status: z.enum(['running', 'cancelling']),
    startedAt: z.iso.datetime(),
  }),
  RUN_IDENTITY_SCHEMA.extend({
    status: z.enum(['completed', 'cancelled']),
    finishedAt: z.iso.datetime(),
  }),
  RUN_IDENTITY_SCHEMA.extend({
    status: z.enum(['failed', 'recovery_required']),
    finishedAt: z.iso.datetime(),
    error: z.string(),
  }),
]);

/** Validates a durable message projection. */
export const AGENT_MESSAGE_SCHEMA: z.ZodType<AgentMessage> = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  runId: z.uuid(),
  role: z.enum(['user', 'assistant', 'tool']),
  state: z.enum(['pending', 'completed', 'interrupted']),
  text: z.string(),
  position: z.number().int().positive(),
});

/** Validates a resynchronizable conversation view. */
export const SESSION_SNAPSHOT_SCHEMA: z.ZodType<SessionSnapshot> = z.object({
  session: AGENT_SESSION_SCHEMA,
  run: AGENT_RUN_SCHEMA.nullable(),
  messages: z.array(AGENT_MESSAGE_SCHEMA),
});

/** Validates transient progress before it crosses Redis or HTTP boundaries. */
export const SESSION_EVENT_SCHEMA: z.ZodType<SessionEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: AGENT_MESSAGE_SCHEMA }),
  z.object({ type: z.literal('run'), run: AGENT_RUN_SCHEMA }),
  z.object({
    type: z.literal('tool'),
    runId: z.uuid(),
    id: z.string().min(1),
    name: z.string().min(1),
    state: z.enum(['running', 'completed', 'failed']),
  }),
]);
