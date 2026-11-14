import type { BetterAuthPlugin } from 'better-auth';
import { type OrganizationOptions, organization } from 'better-auth/plugins/organization';
import type { SendEmail } from '../infrastructure/email/index.js';
import { WORKSPACE_ROLES } from './permissions.js';

const INVITATION_VALIDITY_DAYS = 7;
const INVITATION_DURATION_SECONDS = INVITATION_VALIDITY_DAYS * 24 * 60 * 60;

/** Configures human collaboration through the SDK's organization protocol and lifecycle. */
export function createWorkspacePlugin({
  baseUrl,
  sendEmail,
}: {
  baseUrl: string;
  sendEmail: SendEmail | undefined;
}): BetterAuthPlugin {
  const sendInvitationEmail = sendEmail
    ? createInvitationSender({ baseUrl, sendEmail })
    : undefined;

  // Keep workspace management on the same verified identity used by the login providers.
  return organization({
    roles: WORKSPACE_ROLES,
    allowUserToCreateOrganization: (user) => user.emailVerified,
    requireEmailVerificationOnInvitation: true,
    invitationExpiresIn: INVITATION_DURATION_SECONDS,
    teams: { enabled: false },
    dynamicAccessControl: { enabled: false },
    ...(sendInvitationEmail ? { sendInvitationEmail } : {}),
  });
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
