import {
  type LoginMethod,
  USER_PROFILE_SCHEMA,
  type UserProfile,
} from '@always-on/contracts/users';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import {
  type BetterAuthOptions,
  type BetterAuthPlugin,
  type BetterAuthRateLimitOptions,
  betterAuth,
} from 'better-auth';
import { DATABASE_SCHEMA, type Database } from '../database/index.js';
import type { SendEmail } from '../email/index.js';

const CLIENT_IP_HEADER = 'x-always-on-client-ip';
const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;
const SESSION_REFRESH_SECONDS = 24 * 60 * 60;
const EMAIL_TOKEN_DURATION_SECONDS = 60 * 60;

/** Provider credentials have already been parsed together at startup. */
export type OAuthCredentials = { clientId: string; clientSecret: string };
/** Identity configuration independent of deployment variable names. */
export type AuthenticationConfig = {
  name: string;
  baseUrl: string;
  secret: string;
  google: OAuthCredentials | undefined;
  github: OAuthCredentials | undefined;
};
/** Login and profile resolution, with SDK background work owned by the process scope. */
export interface Authentication extends AsyncDisposable {
  readonly methods: readonly LoginMethod[];
  readonly handle: (input: { request: Request; clientIp: string | undefined }) => Promise<Response>;
  readonly getUser: (headers: Headers) => Promise<UserProfile | null>;
}

/** Builds the SDK once and exposes a separate, allowlisted profile capability. */
export function createAuthentication({
  db,
  config,
  sendEmail,
  rateLimit,
  onError,
  plugins = [],
}: {
  db: Database;
  config: AuthenticationConfig;
  sendEmail: SendEmail | undefined;
  rateLimit: NonNullable<BetterAuthRateLimitOptions['customStorage']>;
  onError: (error: Error) => void;
  plugins?: BetterAuthPlugin[];
}): Authentication {
  const pending = new Set<Promise<unknown>>();
  const methods: LoginMethod[] = [];
  if (config.google) methods.push('google');
  if (config.github) methods.push('github');
  if (sendEmail) methods.push('email-password');

  const socialProviders = {
    ...(config.google ? { google: config.google } : {}),
    ...(config.github ? { github: config.github } : {}),
  };
  const auth = betterAuth({
    appName: config.name,
    baseURL: config.baseUrl,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [new URL(config.baseUrl).origin],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: DATABASE_SCHEMA,
      transaction: true,
    }),
    socialProviders,
    plugins,
    emailAndPassword: {
      enabled: sendEmail !== undefined,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: EMAIL_TOKEN_DURATION_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      expiresIn: EMAIL_TOKEN_DURATION_SECONDS,
      sendVerificationEmail,
    },
    session: {
      expiresIn: SESSION_DURATION_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
      cookieCache: { enabled: false },
    },
    // Linking requires an authenticated action; matching email strings alone never merge users.
    account: { encryptOAuthTokens: true, accountLinking: { disableImplicitLinking: true } },
    rateLimit: { enabled: true, window: 60, max: 100, customStorage: rateLimit },
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      disableOriginCheck: false,
      disableCSRFCheck: false,
      backgroundTasks: { handler: schedule },
    },
    logger: { level: 'error', log: reportSdkError },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions);

  return { methods, handle, getUser, [Symbol.asyncDispose]: dispose };

  async function handle({ request, clientIp }: { request: Request; clientIp: string | undefined }) {
    const headers = new Headers(request.headers);
    // Only the server's socket address may supply this header; discard client-supplied values.
    headers.delete(CLIENT_IP_HEADER);
    if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);

    return await auth.handler(new Request(request, { headers }));
  }

  async function getUser(headers: Headers) {
    // Persisted sessions make logout and password-reset revocation effective on the next request.
    const trustedHeaders = new Headers(headers);
    trustedHeaders.delete(CLIENT_IP_HEADER);
    const session = await auth.api.getSession({ headers: trustedHeaders });
    if (!session) return null;

    // The profile allowlist keeps SDK timestamps, session tokens and provider credentials private.
    return USER_PROFILE_SCHEMA.parse({ ...session.user, image: session.user.image ?? null });
  }

  async function sendVerificationEmail({ user, url }: { user: { email: string }; url: string }) {
    // OAuth can also request verification, even when password sign-in is disabled.
    if (!sendEmail) throw new Error('Email delivery is not configured');

    // Better Auth signs and expires the link; this callback only delivers it.
    await sendEmail({
      to: user.email,
      subject: `Verify your email · ${config.name}`,
      text: `Verify your email address:\n\n${url}\n\nThis link expires in one hour.`,
    });
  }

  async function sendResetPassword({ user, url }: { user: { email: string }; url: string }) {
    if (!sendEmail) throw new Error('Email delivery is not configured');

    // The SDK owns token issuance and consumption. The URL must never enter application logs.
    await sendEmail({
      to: user.email,
      subject: `Reset your password · ${config.name}`,
      text: `Reset your password:\n\n${url}\n\nThis link expires in one hour. Ignore this message if you did not request a reset.`,
    });
  }

  function reportSdkError(_level: unknown, message: string, ...details: unknown[]) {
    // Preserve Error causes while excluding arbitrary SDK objects that may contain credentials.
    const cause = details.find((detail) => detail instanceof Error);
    onError(new Error(`Authentication: ${message}`, { cause }));
  }

  function schedule(task: Promise<unknown>) {
    // Deferred SDK work belongs to the process scope after its HTTP request has completed.
    pending.add(task);
    void observe(task);
  }

  async function observe(task: Promise<unknown>) {
    // Background failures no longer have a request error boundary, so report them here.
    try {
      await task;
    } catch (error) {
      onError(new Error('Authentication background task failed', { cause: error }));
    } finally {
      // A long-lived API must not retain completed promises and their captured credentials.
      pending.delete(task);
    }
  }

  async function dispose() {
    // HTTP closes first; finish accepted mail and session updates before releasing their connections.
    // Tasks may schedule follow-up work, so one snapshot of the pending set is insufficient.
    const failures = new Set<unknown>();

    while (pending.size > 0) {
      // Wait for every task before surfacing independent failures during teardown.
      const outcomes = await Promise.allSettled(pending);

      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') continue;

        failures.add(outcome.reason);
      }
    }
    if (failures.size > 0)
      throw new AggregateError(failures, 'Authentication background work failed during shutdown');
  }
}
