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
  readonly status: 'active' | 'disabled';
}

type AgentChanges = Pick<
  Agent,
  'name' | 'instructions' | 'model' | 'reasoningEffort' | 'visibility' | 'status'
>;

/** Editable defaults and availability; workspace and creator identities remain immutable. */
export type UpdateAgent = { readonly [Key in keyof AgentChanges]?: AgentChanges[Key] | undefined };

/** A private conversation with its current defaults for subsequent Runs. */
export type AgentSession = {
  readonly id: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly configuration: AgentConfiguration;
  readonly revision: number;
  readonly createdAt: string;
  readonly title: string | null;
  readonly status: 'active' | 'archived';
};

/** User-owned conversation organization, independent of execution configuration. */
export type UpdateSession = {
  readonly title?: AgentSession['title'] | undefined;
  readonly status?: AgentSession['status'] | undefined;
};

/** Durable deletion progress, retained until every owned resource has been released. */
export type SessionDeletion = {
  readonly sessionId: string;
  readonly status: 'deleting';
  readonly requestedAt: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly errorCode: 'resource_cleanup_failed' | null;
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

/** A bounded window of durable messages, ordered from oldest to newest within this page. */
export type SessionMessagePage = {
  readonly messages: readonly AgentMessage[];
  readonly nextCursor: string | null;
};

/** The latest durable message window and execution state for stream resynchronization. */
export interface SessionSnapshot extends SessionMessagePage {
  readonly session: AgentSession;
  readonly run: AgentRun | null;
}

/** Private conversation metadata without instructions, checkpoints or execution credentials. */
export interface SessionSummary
  extends Pick<AgentSession, 'id' | 'agentId' | 'workspaceId' | 'createdAt' | 'title' | 'status'> {
  readonly run: AgentRun | null;
}

/** Conversations ordered by creation time and ID, newest first. */
export type SessionListPage = {
  readonly sessions: readonly SessionSummary[];
  readonly nextCursor: string | null;
};

/** Parsed history selection; cursors identify an earlier message in the same Session. */
export type SessionHistoryQuery = {
  readonly limit: number;
  readonly cursor?: string | undefined;
};

/** Parsed private conversation selection within one Workspace. */
export interface SessionListQuery extends SessionHistoryQuery {
  readonly workspaceId: string;
  readonly status: AgentSession['status'];
}

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
const CONFIGURATION_FIELDS = {
  instructions: INSTRUCTIONS_SCHEMA,
  model: MODEL_REFERENCE_SCHEMA,
  reasoningEffort: z.string().trim().min(1).max(32),
};
const VISIBILITY_SCHEMA = z.enum(['private', 'workspace']);
const SESSION_STATUS_SCHEMA = z.enum(['active', 'archived']);
const AGENT_SETTINGS_SCHEMA = z.strictObject({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  ...CONFIGURATION_FIELDS,
  visibility: VISIBILITY_SCHEMA,
});
const RUN_IDENTITY_SCHEMA = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  createdAt: z.iso.datetime(),
});

/** Default window for HTTP history and every SSE snapshot or reset. */
export const SESSION_PAGE_SIZE = 50;

const MAX_PAGE_SIZE = 100;
const PAGE_QUERY_FIELDS = {
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(SESSION_PAGE_SIZE),
  cursor: z.uuid().optional(),
};

/** Bounds history reads and validates the opaque message cursor at the HTTP boundary. */
export const SESSION_HISTORY_QUERY_SCHEMA: z.ZodType<SessionHistoryQuery> =
  z.strictObject(PAGE_QUERY_FIELDS);

/** Bounds conversation discovery and requires an explicit Workspace. */
export const SESSION_LIST_QUERY_SCHEMA: z.ZodType<SessionListQuery> = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  workspaceId: z.string().trim().min(1).max(200),
  status: SESSION_STATUS_SCHEMA.default('active'),
});

/** Validates execution settings at storage boundaries. */
export const AGENT_CONFIGURATION_SCHEMA: z.ZodType<AgentConfiguration> =
  z.strictObject(CONFIGURATION_FIELDS);

/** Parses Agent creation and resolves documented defaults. */
export const CREATE_AGENT_SCHEMA: z.ZodType<CreateAgent> = AGENT_SETTINGS_SCHEMA.extend({
  visibility: VISIBILITY_SCHEMA.default('private'),
});

/** Parses partial edits without applying creation defaults to omitted fields. */
export const UPDATE_AGENT_SCHEMA: z.ZodType<UpdateAgent> = AGENT_SETTINGS_SCHEMA.omit({
  workspaceId: true,
})
  .partial()
  .extend({ status: z.enum(['active', 'disabled']).optional() })
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one Agent change');

/** Parses explicit naming or archive changes; empty patches and protected fields are rejected. */
export const UPDATE_SESSION_SCHEMA: z.ZodType<UpdateSession> = z
  .strictObject({
    title: z.string().trim().min(1).max(200).nullable().optional(),
    status: SESSION_STATUS_SCHEMA.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one Session change');

/** Validates observable cleanup progress without exposing resource identities or SDK errors. */
export const SESSION_DELETION_SCHEMA: z.ZodType<SessionDeletion> = z.object({
  sessionId: z.uuid(),
  status: z.literal('deleting'),
  requestedAt: z.iso.datetime(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.iso.datetime(),
  errorCode: z.literal('resource_cleanup_failed').nullable(),
});

/** Validates a saved Agent definition. */
export const AGENT_SCHEMA: z.ZodType<Agent> = AGENT_SETTINGS_SCHEMA.extend({
  id: z.uuid(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  status: z.enum(['active', 'disabled']),
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
  title: z.string().nullable(),
  status: SESSION_STATUS_SCHEMA,
});

/** A stable source identity makes an acknowledged submission safe to retry. */
export const SUBMIT_MESSAGE_SCHEMA: z.ZodType<{ sourceEventId: string; text: string }> =
  z.strictObject({
    sourceEventId: z.string().min(1).max(500),
    text: z.string().trim().min(1).max(64_000),
  });

/** Records a human reconciliation decision after the previous execution has stopped. */
export const RECONCILE_RUN_SCHEMA: z.ZodType<{ reason: string }> = z.strictObject({
  reason: z.string().trim().min(1).max(2_000),
});

/** Selects a former member's resources without requesting any private content. */
export const OFFBOARD_MEMBER_SCHEMA: z.ZodType<{ workspaceId: string; userId: string }> =
  z.strictObject({
    workspaceId: z.string().trim().min(1).max(200),
    userId: z.string().trim().min(1).max(200),
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

const MESSAGE_PAGE_FIELDS = {
  messages: z.array(AGENT_MESSAGE_SCHEMA).max(MAX_PAGE_SIZE),
  nextCursor: z.uuid().nullable(),
};

/** Validates a resynchronizable conversation view. */
export const SESSION_SNAPSHOT_SCHEMA: z.ZodType<SessionSnapshot> = z.object({
  session: AGENT_SESSION_SCHEMA,
  run: AGENT_RUN_SCHEMA.nullable(),
  ...MESSAGE_PAGE_FIELDS,
});

/** Validates the message window and its cursor for loading older durable history. */
export const SESSION_MESSAGE_PAGE_SCHEMA: z.ZodType<SessionMessagePage> =
  z.object(MESSAGE_PAGE_FIELDS);

const SESSION_SUMMARY_SCHEMA = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  workspaceId: z.string(),
  createdAt: z.iso.datetime(),
  title: z.string().nullable(),
  status: SESSION_STATUS_SCHEMA,
  run: AGENT_RUN_SCHEMA.nullable(),
});

/** Validates the public conversation list without admitting private execution settings. */
export const SESSION_LIST_PAGE_SCHEMA: z.ZodType<SessionListPage> = z.object({
  sessions: z.array(SESSION_SUMMARY_SCHEMA).max(MAX_PAGE_SIZE),
  nextCursor: z.uuid().nullable(),
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
