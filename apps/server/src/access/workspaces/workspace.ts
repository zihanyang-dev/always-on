export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export const INVITATION_ROLES = ['member', 'viewer'] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type InvitationRole = (typeof INVITATION_ROLES)[number];

export type WorkspaceActor = { workspaceId: string; userId: string };
export type Workspace = { id: string; name: string; createdAt: Date; role: WorkspaceRole };
export type WorkspaceMember = {
  userId: string;
  name: string;
  image: string | null;
  role: WorkspaceRole;
  joinedAt: Date;
};
export type WorkspaceInvitation = {
  id: string;
  workspaceId: string;
  email: string;
  role: InvitationRole;
  createdAt: Date;
  expiresAt: Date;
};

export type WorkspaceError =
  | 'not_found'
  | 'forbidden'
  | 'last_owner'
  | 'already_member'
  | 'invitation_used';

export type WorkspaceResult<T> = { ok: true; value: T } | { ok: false; error: WorkspaceError };

export function success<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function failure<E extends WorkspaceError>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

export function canManageWorkspace(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function canChangeMembership({
  actorRole,
  currentRole,
  nextRole,
}: {
  actorRole: WorkspaceRole;
  currentRole: WorkspaceRole;
  nextRole: WorkspaceRole | null;
}): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole !== 'admin' || canManageWorkspace(currentRole)) return false;

  return nextRole === null || !canManageWorkspace(nextRole);
}
