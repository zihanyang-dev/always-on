import type { OrganizationOptions } from 'better-auth/plugins/organization';
import { adminAc, defaultAc, memberAc, ownerAc } from 'better-auth/plugins/organization/access';

/** Preserves the SDK's management permissions and adds membership-only, read-only access. */
export const WORKSPACE_ROLES = {
  owner: ownerAc,
  admin: adminAc,
  member: memberAc,
  viewer: defaultAc.newRole({}),
} satisfies NonNullable<OrganizationOptions['roles']>;
