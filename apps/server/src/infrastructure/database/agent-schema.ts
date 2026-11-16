import type { Agent, AgentRun, AgentSession } from '@always-on/contracts/agents';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { AUTH_USERS } from './authentication-schema.js';
import { INBOX_EVENTS } from './schema.js';
import { WORKSPACES } from './workspace-schema.js';

/** Reusable Agent definitions; credentials stay outside product configuration. */
export const AGENTS = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => WORKSPACES.id, { onDelete: 'restrict' }),
  createdBy: text('created_by')
    .notNull()
    .references(() => AUTH_USERS.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  visibility: text('visibility', { enum: ['private', 'workspace'] }).notNull(),
  configuration: jsonb('configuration').$type<unknown>().notNull(),
  status: text('status').$type<Agent['status']>().notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Conversations own their native checkpoint and the identity of their execution environment. */
export const AGENT_SESSIONS = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => AGENTS.id, { onDelete: 'restrict' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => WORKSPACES.id, { onDelete: 'restrict' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => AUTH_USERS.id, { onDelete: 'restrict' }),
    configuration: jsonb('configuration').$type<unknown>().notNull(),
    title: text('title'),
    status: text('status').$type<AgentSession['status'] | 'deleting'>().notNull().default('active'),
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    cleanupAttempts: integer('cleanup_attempts').notNull().default(0),
    cleanupAfter: timestamp('cleanup_after', { withTimezone: true }),
    cleanupError: text('cleanup_error'),
    revision: integer('revision').notNull().default(0),
    checkpoint: jsonb('execution_checkpoint').$type<unknown>(),
    sandboxId: text('sandbox_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_sessions_owner_created_idx').on(
      table.workspaceId,
      table.createdBy,
      table.createdAt,
      table.id,
    ),
    index('agent_sessions_cleanup_idx')
      .on(table.cleanupAfter)
      .where(sql`${table.status} = 'deleting'`),
    check(
      'agent_sessions_lifecycle_check',
      sql`(${table.status} in ('active', 'archived') and ${table.deletionRequestedAt} is null
          and ${table.cleanupAfter} is null and ${table.cleanupAttempts} = 0 and ${table.cleanupError} is null)
        or (${table.status} = 'deleting' and ${table.deletionRequestedAt} is not null
          and ${table.cleanupAfter} is not null and ${table.cleanupAttempts} >= 0)`,
    ),
  ],
);

/** A queued row is also the durable dispatch intent; BullMQ only wakes a claimant. */
export const AGENT_RUNS = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => AGENT_SESSIONS.id, { onDelete: 'cascade' }),
    inputId: uuid('input_id')
      .notNull()
      .unique()
      .references(() => INBOX_EVENTS.id, { onDelete: 'restrict' }),
    configuration: jsonb('configuration').$type<unknown>().notNull(),
    inputText: text('input_text').notNull(),
    status: text('status').$type<AgentRun['status']>().notNull().default('queued'),
    ownerToken: uuid('owner_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_runs_pending_idx').on(table.status, table.createdAt),
    index('agent_runs_session_idx').on(table.sessionId, table.createdAt),
    // Match the display order without sorting all earlier Runs for every listed Session.
    index('agent_runs_session_display_idx').on(
      table.sessionId,
      sql`(${table.status} in ('running', 'cancelling', 'recovery_required'))`,
      table.createdAt,
      table.id,
    ),
    // The database enforces one writer even when queue delivery and lease renewal race.
    uniqueIndex('agent_runs_session_writer')
      .on(table.sessionId)
      .where(sql`${table.status} in ('running', 'cancelling')`),
    check(
      'agent_runs_state_check',
      sql`(${table.status} = 'queued' and ${table.ownerToken} is null and ${table.finishedAt} is null)
        or (${table.status} in ('running', 'cancelling') and ${table.ownerToken} is not null
          and ${table.leaseUntil} is not null and ${table.startedAt} is not null and ${table.finishedAt} is null)
        or (${table.status} in ('completed', 'cancelled') and ${table.finishedAt} is not null)
        or (${table.status} in ('failed', 'recovery_required') and ${table.finishedAt} is not null and ${table.error} is not null)`,
    ),
  ],
);

/** Durable display messages, ordered separately from the SDK's native transcript. */
export const AGENT_MESSAGES = pgTable(
  'agent_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => AGENT_SESSIONS.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => AGENT_RUNS.id, { onDelete: 'cascade' }),
    messageIndex: integer('message_index').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
    state: text('state', { enum: ['pending', 'completed', 'interrupted'] }).notNull(),
    text: text('text').notNull(),
    position: integer('position').generatedAlwaysAsIdentity().notNull(),
  },
  (table) => [
    uniqueIndex('agent_messages_run_ordinal').on(table.runId, table.messageIndex),
    index('agent_messages_session_position').on(table.sessionId, table.position),
  ],
);

/** Tool intents are committed before dispatch; an unfinished one forbids automatic replay. */
export const AGENT_TOOL_CALLS = pgTable('agent_tool_calls', {
  id: uuid('id').primaryKey(),
  runId: uuid('run_id')
    .notNull()
    .references(() => AGENT_RUNS.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: text('status', { enum: ['pending', 'completed', 'failed'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

/** Registers product tables without exposing provider SDK state as a database model. */
export const AGENT_TABLES = {
  agents: AGENTS,
  agentSessions: AGENT_SESSIONS,
  agentRuns: AGENT_RUNS,
  agentMessages: AGENT_MESSAGES,
  agentToolCalls: AGENT_TOOL_CALLS,
};
