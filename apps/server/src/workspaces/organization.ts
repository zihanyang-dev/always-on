import type { BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import { type OrganizationOptions, organization } from 'better-auth/plugins/organization';
import type { SendEmail } from '../infrastructure/email/index.js';
import { WORKSPACE_ACCESS_CONTROL, WORKSPACE_ROLES } from './permissions.js';

const INVITATION_VALIDITY_DAYS = 7;
const INVITATION_DURATION_SECONDS = INVITATION_VALIDITY_DAYS * 24 * 60 * 60;

/** Configures human collaboration through the SDK's organization protocol and lifecycle. */
export function createWorkspacePlugin({
  baseUrl,
  sendEmail,
  canDeleteWorkspace,
}: {
  baseUrl: string;
  sendEmail: SendEmail | undefined;
  canDeleteWorkspace?: (workspaceId: string) => Promise<boolean>;
}): BetterAuthPlugin {
  const sendInvitationEmail = sendEmail
    ? createInvitationSender({ baseUrl, sendEmail })
    : undefined;

  // Keep workspace management on the same verified identity used by the login providers.
  return organization({
    ac: WORKSPACE_ACCESS_CONTROL,
    roles: WORKSPACE_ROLES,
    allowUserToCreateOrganization: (user) => user.emailVerified,
    requireEmailVerificationOnInvitation: true,
    invitationExpiresIn: INVITATION_DURATION_SECONDS,
    teams: { enabled: false },
    dynamicAccessControl: { enabled: false },
    organizationHooks: { beforeDeleteOrganization },
    ...(sendInvitationEmail ? { sendInvitationEmail } : {}),
  });

  async function beforeDeleteOrganization({ organization }: { organization: { id: string } }) {
    // The SDK holds its organization lock; the FK also protects concurrent resource creation.
    if (!canDeleteWorkspace || (await canDeleteWorkspace(organization.id))) return;
    throw new APIError('CONFLICT', {
      code: 'WORKSPACE_HAS_AGENTS',
      message: `Workspace ${organization.id} still owns Agents and execution resources`,
    });
  }
}

function createInvitationSender({
  baseUrl,
  sendEmail,
}: {
  baseUrl: string;
  sendEmail: SendEmail;
}): NonNullable<OrganizationOptions['sendInvitationEmail']> {
  return async function sendInvitation({ id, email, organization, inviter }) {
    // Until a frontend exists, the link resolves to the authenticated SDK details endpoint.
    // Reviewing is a GET; accepting still requires the SDK's explicit POST and matching identity.
    const invitationUrl = new URL('/api/auth/organization/get-invitation', baseUrl);
    invitationUrl.searchParams.set('id', id);
    await sendEmail({
      to: email,
      subject: `Join ${organization.name}`,
      text: `${inviter.user.name} invited you to join ${organization.name}.\n\nReview your invitation:\n${invitationUrl}\n\nSign in with ${email} to accept. This invitation expires in ${INVITATION_VALIDITY_DAYS} days.`,
    });
  };
}
