import { type BetterAuthOptions, betterAuth } from 'better-auth';
import type { SendEmail } from '../../infrastructure/index.ts';
import { authDatabase } from './persistence/auth-database.ts';

const CLIENT_IP_HEADER = 'x-always-on-client-ip';
const LINK_TTL_SECONDS = 3600;

export type OAuthCredentials = { clientId: string; clientSecret: string };

export type AuthenticationConfig = {
  origin: string;
  secret: string;
  github?: OAuthCredentials | undefined;
  google?: OAuthCredentials | undefined;
};

export type SignedInUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
};

type LoginMethod = 'email-password' | 'github' | 'google';
type Authentication = {
  loginMethods: readonly LoginMethod[];
  handle: (input: { request: Request; clientIp?: string | undefined }) => Promise<Response>;
  getUser: (headers: Headers) => Promise<SignedInUser | null>;
};

/** Resolves application identity from a login session. Workspace access is checked separately. */
export function createAuthentication({
  db,
  config,
  sendEmail,
}: {
  db: Parameters<typeof authDatabase>[0];
  config: AuthenticationConfig;
  sendEmail: SendEmail | undefined;
}): Authentication {
  const socialProviders = {
    ...(config.github && { github: config.github }),
    ...(config.google && { google: config.google }),
  };
  const auth = betterAuth({
    database: authDatabase(db),
    appName: 'Always On',
    basePath: '/api/auth',
    baseURL: config.origin,
    trustedOrigins: [config.origin],
    secret: config.secret,
    socialProviders,
    user: { modelName: 'users' },
    session: { modelName: 'auth_sessions' },
    account: {
      modelName: 'auth_accounts',
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, disableImplicitLinking: true },
    },
    verification: { modelName: 'auth_verifications', storeIdentifier: 'hashed' },
    rateLimit: { modelName: 'auth_rate_limits', enabled: true, storage: 'database' },
    ...(sendEmail && emailLogin(sendEmail)),
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    logger: { disabled: true },
    onAPIError: { throw: true },
    telemetry: { enabled: false },
  });

  const loginMethods: LoginMethod[] = [];
  if (sendEmail) loginMethods.push('email-password');
  if (socialProviders.github) loginMethods.push('github');
  if (socialProviders.google) loginMethods.push('google');

  return { loginMethods, handle, getUser };

  function handle({ request, clientIp }: Parameters<Authentication['handle']>[0]) {
    const headers = new Headers(request.headers);
    headers.delete(CLIENT_IP_HEADER);
    if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);

    return auth.handler(new Request(request, { headers }));
  }

  async function getUser(headers: Headers) {
    const session = await auth.api.getSession({ headers, query: { disableRefresh: true } });
    if (!session) return null;

    const { id, name, email, emailVerified, image } = session.user;
    return { id, name, email, emailVerified, image: image ?? null };
  }
}

function emailLogin(sendEmail: SendEmail) {
  return {
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      autoSignIn: false,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: LINK_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) =>
        sendLink({ email: user.email, url, subject: 'Reset your password' }),
    },
    emailVerification: {
      expiresIn: LINK_TTL_SECONDS,
      sendOnSignUp: true,
      sendOnSignIn: true,
      sendVerificationEmail: ({ user, url }) =>
        sendLink({ email: user.email, url, subject: 'Verify your email' }),
    },
  } satisfies Pick<BetterAuthOptions, 'emailAndPassword' | 'emailVerification'>;

  function sendLink({ email, url, subject }: { email: string; url: string; subject: string }) {
    return sendEmail({
      to: email,
      subject: `${subject} · Always On`,
      text: `${subject}\n\n${url}`,
    });
  }
}
