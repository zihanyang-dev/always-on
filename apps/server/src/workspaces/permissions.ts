import { createAccessControl } from 'better-auth/plugins/access';
import type { OrganizationOptions } from 'better-auth/plugins/organization';
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';

const AGENT_ACTIONS = ['read', 'create', 'use'] as const;

/** Adds application resources while retaining the SDK's organization management statements. */
export const WORKSPACE_ACCESS_CONTROL = createAccessControl({
  ...defaultStatements,
  agent: AGENT_ACTIONS,
});

/** Preserves the SDK's management permissions and adds membership-only, read-only access. */
export const WORKSPACE_ROLES = {
  owner: WORKSPACE_ACCESS_CONTROL.newRole({ ...ownerAc.statements, agent: AGENT_ACTIONS }),
  admin: WORKSPACE_ACCESS_CONTROL.newRole({ ...adminAc.statements, agent: AGENT_ACTIONS }),
  member: WORKSPACE_ACCESS_CONTROL.newRole({ ...memberAc.statements, agent: AGENT_ACTIONS }),
  viewer: WORKSPACE_ACCESS_CONTROL.newRole({ agent: ['read'] }),
} satisfies NonNullable<OrganizationOptions['roles']>;

/** Checks fixed SDK roles; resource ownership and visibility remain application decisions. */
export function hasAgentPermission({
  roles,
  action,
}: {
  roles: string;
  action: (typeof AGENT_ACTIONS)[number];
}): boolean {
  return roles.split(',').some((role) => {
    if (!isWorkspaceRole(role)) return false;

    return WORKSPACE_ROLES[role].authorize({ agent: [action] }).success;
  });
}

function isWorkspaceRole(role: string): role is keyof typeof WORKSPACE_ROLES {
  return Object.hasOwn(WORKSPACE_ROLES, role);
}
