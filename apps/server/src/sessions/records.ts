import {
  AGENT_CONFIGURATION_SCHEMA,
  AGENT_RUN_SCHEMA,
  AGENT_SESSION_SCHEMA,
  type AgentRun,
  type AgentSession,
} from '@always-on/contracts/agents';
import type { AGENT_RUNS, AGENT_SESSIONS } from '../infrastructure/database/index.js';

type RunViewRow = Pick<
  typeof AGENT_RUNS.$inferSelect,
  'id' | 'sessionId' | 'createdAt' | 'status' | 'startedAt' | 'finishedAt' | 'error'
>;

/** Validates persisted settings and strips private storage references from a Session. */
export function parseSession(row: typeof AGENT_SESSIONS.$inferSelect): AgentSession {
  const configuration = AGENT_CONFIGURATION_SCHEMA.parse(row.configuration);

  return AGENT_SESSION_SCHEMA.parse({
    ...row,
    configuration,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Projects only public Run facts, converting storage timestamps at the read boundary. */
export function parseRun(row: RunViewRow): AgentRun {
  return AGENT_RUN_SCHEMA.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  });
}
