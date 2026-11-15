import {
  AGENT_CONFIGURATION_SCHEMA,
  AGENT_SCHEMA,
  type Agent,
  type AgentConfiguration,
  type CreateAgent,
} from '@always-on/contracts/agents';
import type { ModelOption } from '@always-on/contracts/models';
import { and, eq, or } from 'drizzle-orm';
import {
  AGENTS,
  type Database,
  type DatabaseTransaction,
  WORKSPACE_MEMBERS,
} from '../infrastructure/database/index.js';
import { hasAgentPermission } from '../workspaces/index.js';

type AgentRow = typeof AGENTS.$inferSelect;

/** Preserves execution-resource ownership until an explicit Agent deletion lifecycle exists. */
export async function hasWorkspaceAgents({
  db,
  workspaceId,
}: {
  db: Database;
  workspaceId: string;
}): Promise<boolean> {
  const [agent] = await db
    .select({ id: AGENTS.id })
    .from(AGENTS)
    .where(eq(AGENTS.workspaceId, workspaceId))
    .limit(1);

  return agent !== undefined;
}

/** Saves an Agent only while the creator retains permission in its workspace. */
export async function createAgent({
  db,
  userId,
  input,
}: {
  db: Database;
  userId: string;
  input: CreateAgent;
}): Promise<Agent | null> {
  return db.transaction(create);

  async function create(transaction: DatabaseTransaction) {
    const roles = await readMembership({ transaction, workspaceId: input.workspaceId, userId });
    if (!roles || !hasAgentPermission({ roles, action: 'create' })) return null;

    const configuration = {
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      instructions: input.instructions,
    } satisfies AgentConfiguration;
    const [created] = await transaction
      .insert(AGENTS)
      .values({
        workspaceId: input.workspaceId,
        createdBy: userId,
        name: input.name,
        visibility: input.visibility,
        configuration,
      })
      .returning();
    if (!created)
      throw new Error(`Agent creation in workspace ${input.workspaceId} returned no row`);

    return parseAgent(created);
  }
}

/** Lists definitions visible to the caller after checking current workspace membership. */
export async function listAgents({
  db,
  workspaceId,
  userId,
}: {
  db: Database;
  workspaceId: string;
  userId: string;
}): Promise<readonly Agent[] | null> {
  return db.transaction(list);

  async function list(transaction: DatabaseTransaction) {
    const roles = await readMembership({ transaction, workspaceId, userId });
    if (!roles || !hasAgentPermission({ roles, action: 'read' })) return null;

    const rows = await transaction
      .select()
      .from(AGENTS)
      .where(
        and(
          eq(AGENTS.workspaceId, workspaceId),
          or(eq(AGENTS.createdBy, userId), eq(AGENTS.visibility, 'workspace')),
        ),
      )
      .orderBy(AGENTS.createdAt, AGENTS.id)
      .limit(100);

    return rows.map(parseAgent);
  }
}

/** Reads an accessible definition under the caller's admission transaction. */
export async function readUsableAgent({
  transaction,
  agentId,
  userId,
}: {
  transaction: DatabaseTransaction;
  agentId: string;
  userId: string;
}): Promise<Agent | null> {
  const [agent] = await transaction
    .select()
    .from(AGENTS)
    .where(eq(AGENTS.id, agentId))
    .for('share');
  if (!agent) return null;
  if (agent.visibility === 'private' && agent.createdBy !== userId) return null;

  const roles = await readMembership({ transaction, workspaceId: agent.workspaceId, userId });
  if (!roles || !hasAgentPermission({ roles, action: 'use' })) return null;

  return parseAgent(agent);
}

/** Checks model and effort together against the actual deployment catalogue. */
export function isAvailableConfiguration({
  configuration,
  models,
}: {
  configuration: AgentConfiguration;
  models: readonly ModelOption[];
}): boolean {
  const selected = models.find(
    (model) =>
      model.provider === configuration.model.provider && model.id === configuration.model.id,
  );

  return selected?.reasoningEfforts.includes(configuration.reasoningEffort) ?? false;
}

async function readMembership({
  transaction,
  workspaceId,
  userId,
}: {
  transaction: DatabaseTransaction;
  workspaceId: string;
  userId: string;
}) {
  // A membership removal waits for this short admission transaction, never for model execution.
  const [membership] = await transaction
    .select({ roles: WORKSPACE_MEMBERS.role })
    .from(WORKSPACE_MEMBERS)
    .where(
      and(eq(WORKSPACE_MEMBERS.organizationId, workspaceId), eq(WORKSPACE_MEMBERS.userId, userId)),
    )
    .for('share');

  return membership?.roles;
}

function parseAgent(row: AgentRow) {
  const configuration = AGENT_CONFIGURATION_SCHEMA.parse(row.configuration);

  return AGENT_SCHEMA.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    createdBy: row.createdBy,
    name: row.name,
    visibility: row.visibility,
    ...configuration,
    createdAt: row.createdAt.toISOString(),
  });
}
