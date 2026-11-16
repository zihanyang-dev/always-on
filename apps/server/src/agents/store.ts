import {
  AGENT_CONFIGURATION_SCHEMA,
  AGENT_SCHEMA,
  type Agent,
  type AgentConfiguration,
  type CreateAgent,
  type UpdateAgent,
} from '@always-on/contracts/agents';
import type { ModelOption } from '@always-on/contracts/models';
import { and, eq, or } from 'drizzle-orm';
import {
  AGENT_SESSIONS,
  AGENTS,
  type Database,
  type DatabaseTransaction,
  WORKSPACE_MEMBERS,
  WORKSPACE_TABLES,
} from '../infrastructure/database/index.js';
import { hasAgentPermission } from '../workspaces/index.js';

type AgentRow = typeof AGENTS.$inferSelect;

/** A validated partial edit or a current resource/configuration rejection. */
export type AgentUpdateResult =
  | { readonly status: 'updated'; readonly agent: Agent }
  | { readonly status: 'not_found' | 'unsupported_model_configuration' };

/** Preserves Workspace ownership while any Agent definition still exists. */
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

/** Edits defaults under the Agent lock without rewriting existing Session or Run snapshots. */
export async function updateAgent({
  db,
  agentId,
  userId,
  patch,
  models,
}: {
  db: Database;
  agentId: string;
  userId: string;
  patch: UpdateAgent;
  models: readonly ModelOption[];
}): Promise<AgentUpdateResult> {
  return db.transaction(update);

  async function update(transaction: DatabaseTransaction): Promise<AgentUpdateResult> {
    const agent = await readManagedAgent({ transaction, agentId, userId });
    if (!agent) return { status: 'not_found' };

    // Validate the merged choice: changing only a model can invalidate the existing effort.
    const configuration = {
      model: patch.model ?? agent.model,
      reasoningEffort: patch.reasoningEffort ?? agent.reasoningEffort,
      instructions: patch.instructions ?? agent.instructions,
    } satisfies AgentConfiguration;
    const hasModelChange = patch.model !== undefined || patch.reasoningEffort !== undefined;
    if (hasModelChange && !isAvailableConfiguration({ configuration, models }))
      return { status: 'unsupported_model_configuration' };

    const [updated] = await transaction
      .update(AGENTS)
      .set({
        name: patch.name ?? agent.name,
        visibility: patch.visibility ?? agent.visibility,
        status: patch.status ?? agent.status,
        configuration,
      })
      .where(eq(AGENTS.id, agentId))
      .returning();
    if (!updated) throw new Error(`Agent ${agentId} disappeared during update`);

    return { status: 'updated', agent: parseAgent(updated) };
  }
}

/** Deletes an empty definition while preserving all existing private conversation ownership. */
export async function deleteAgent({
  db,
  agentId,
  userId,
}: {
  db: Database;
  agentId: string;
  userId: string;
}): Promise<'deleted' | 'not_found' | 'has_sessions'> {
  return db.transaction(remove);

  async function remove(transaction: DatabaseTransaction) {
    const agent = await readManagedAgent({ transaction, agentId, userId });
    if (!agent) return 'not_found';

    // The Agent lock excludes new Session creation; never cascade teammates' private history.
    const [session] = await transaction
      .select({ id: AGENT_SESSIONS.id })
      .from(AGENT_SESSIONS)
      .where(eq(AGENT_SESSIONS.agentId, agentId))
      .limit(1);
    if (session) return 'has_sessions';

    await transaction.delete(AGENTS).where(eq(AGENTS.id, agentId));

    return 'deleted';
  }
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
    // Match SDK deletion's Workspace → membership order before inserting a dependent Agent.
    const [workspace] = await transaction
      .select({ id: WORKSPACE_TABLES.organization.id })
      .from(WORKSPACE_TABLES.organization)
      .where(eq(WORKSPACE_TABLES.organization.id, input.workspaceId))
      .for('share');
    if (!workspace) return null;

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
  if (agent.status !== 'active') return null;
  if (agent.visibility === 'private' && agent.createdBy !== userId) return null;

  const roles = await readMembership({ transaction, workspaceId: agent.workspaceId, userId });
  if (!roles || !hasAgentPermission({ roles, action: 'use' })) return null;

  return parseAgent(agent);
}

async function readManagedAgent({
  transaction,
  agentId,
  userId,
}: {
  transaction: DatabaseTransaction;
  agentId: string;
  userId: string;
}) {
  const [agent] = await transaction
    .select()
    .from(AGENTS)
    .where(eq(AGENTS.id, agentId))
    .for('update');
  if (!agent) return null;
  if (agent.visibility === 'private' && agent.createdBy !== userId) return null;

  const roles = await readMembership({ transaction, workspaceId: agent.workspaceId, userId });
  if (!roles || !hasAgentPermission({ roles, action: 'update' })) return null;
  const canManage = agent.createdBy === userId || hasAgentPermission({ roles, action: 'manage' });
  if (!canManage) return null;

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
    status: row.status,
    ...configuration,
    createdAt: row.createdAt.toISOString(),
  });
}
