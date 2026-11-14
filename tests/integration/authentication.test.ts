import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { USER_PROFILE_SCHEMA } from '@always-on/contracts/users';
import { getAuthStateVerificationIdentifier } from 'better-auth';
import { eq, inArray } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../apps/server/src/bootstrap/app.js';
import { parseWorkerEnv } from '../../apps/server/src/bootstrap/env.js';
import {
  createAuthentication,
  createAuthRateLimit,
} from '../../apps/server/src/infrastructure/authentication/index.js';
import {
  AUTHENTICATION_TABLES,
  openDatabase,
} from '../../apps/server/src/infrastructure/database/index.js';
import type { EmailMessage } from '../../apps/server/src/infrastructure/email/index.js';
import { openRedis } from '../../apps/server/src/infrastructure/redis/index.js';

const ENV = parseWorkerEnv(process.env);
const BASE_URL = 'http://localhost:3001';
const PASSWORD = 'original-password-for-integration';
const REPLACEMENT_PASSWORD = 'replacement-password-for-integration';
const SIGN_UP_RESPONSE_SCHEMA = z.object({ user: z.object({ id: z.string() }) });
const SOCIAL_RESPONSE_SCHEMA = z.object({ url: z.url() });

it('requires email verification, persists a password hash, and revokes a signed-in session on logout', async () => {
  await using fixture = await openAuthFixture();
  expect((await fixture.request({ path: '/api/me', method: 'GET' })).status).toBe(401);
  const signup = await fixture.signUp();
  expect(signup.status).toBe(200);
  const { user } = SIGN_UP_RESPONSE_SCHEMA.parse(await signup.json());
  const [account] = await fixture.db
    .select()
    .from(AUTHENTICATION_TABLES.account)
    .where(eq(AUTHENTICATION_TABLES.account.userId, user.id));
  assert.ok(account?.password);
  expect(account.password).not.toBe(PASSWORD);
  const unverified = await fixture.signIn(PASSWORD);
  expect(unverified.status).toBe(403);
  await fixture.verifyEmail();
  const signedIn = await fixture.signIn(PASSWORD);
  expect(signedIn.status).toBe(200);
  const cookie = getSessionCookie(signedIn);
  const profileResponse = await fixture.request({ path: '/api/me', method: 'GET', cookie });
  expect(profileResponse.headers.get('cache-control')).toBe('no-store');
  const profile = USER_PROFILE_SCHEMA.parse(await profileResponse.json());
  expect(profile).toEqual({
    id: user.id,
    email: fixture.email,
    emailVerified: true,
    name: 'Test User',
    image: null,
  });
  const signedOut = await fixture.request({ path: '/api/auth/sign-out', cookie, body: {} });
  expect(signedOut.status).toBe(200);
  expect((await fixture.request({ path: '/api/me', method: 'GET', cookie })).status).toBe(401);
});

it('consumes reset tokens once, changes the password, and revokes earlier sessions', async () => {
  await using fixture = await openAuthFixture();
  expect((await fixture.signUp()).status).toBe(200);
  await fixture.verifyEmail();
  const signedIn = await fixture.signIn(PASSWORD);
  const cookie = getSessionCookie(signedIn);
  const requested = await fixture.request({
    path: '/api/auth/request-password-reset',
    body: { email: fixture.email, redirectTo: `${BASE_URL}/api/me` },
  });
  expect(requested.status).toBe(200);
  const message = await fixture.readEmail('Reset your password');
  const resetUrl = getMessageUrl(message);
  const token = resetUrl.pathname.split('/').at(-1);
  assert.ok(token);
  const reset = await fixture.request({
    path: '/api/auth/reset-password',
    body: { token, newPassword: REPLACEMENT_PASSWORD },
  });
  expect(reset.status).toBe(200);
  expect((await fixture.request({ path: '/api/me', method: 'GET', cookie })).status).toBe(401);
  expect((await fixture.signIn(PASSWORD)).status).toBe(401);
  expect((await fixture.signIn(REPLACEMENT_PASSWORD)).status).toBe(200);
  const replay = await fixture.request({
    path: '/api/auth/reset-password',
    body: { token, newPassword: PASSWORD },
  });
  expect(replay.status).toBe(400);
});

it('rejects untrusted origins and redirects before creating an account or starting OAuth', async () => {
  await using fixture = await openAuthFixture();
  const signup = await fixture.request({
    path: '/api/auth/sign-up/email',
    origin: 'https://untrusted.example',
    body: { email: fixture.email, password: PASSWORD, name: 'Test' },
  });
  expect(signup.status).toBe(403);
  const users = await fixture.db
    .select()
    .from(AUTHENTICATION_TABLES.user)
    .where(eq(AUTHENTICATION_TABLES.user.email, fixture.email));
  expect(users).toEqual([]);
  const social = await fixture.request({
    path: '/api/auth/sign-in/social',
    body: { provider: 'google', callbackURL: 'https://untrusted.example' },
  });
  expect(social.status).toBe(403);
});

it.each(['google', 'github'])(
  'builds the %s authorization flow with the registered callback',
  async (provider) => {
    await using fixture = await openAuthFixture();
    const response = await fixture.request({
      path: '/api/auth/sign-in/social',
      body: { provider, callbackURL: '/api/me', disableRedirect: true },
    });
    expect(response.status).toBe(200);
    const authorization = new URL(SOCIAL_RESPONSE_SCHEMA.parse(await response.json()).url);
    expect(authorization.searchParams.get('redirect_uri')).toBe(
      `${BASE_URL}/api/auth/callback/${provider}`,
    );
    const state = authorization.searchParams.get('state');
    assert.ok(state);
    fixture.recordOAuthState(state);
    expect(response.headers.getSetCookie().some((cookie) => cookie.includes('HttpOnly'))).toBe(
      true,
    );
  },
);

it('enforces one shared Redis limit under simultaneous attempts', async () => {
  await using fixture = await openAuthFixture();
  const limit = createAuthRateLimit({ redis: fixture.redis, prefix: fixture.prefix });
  const outcomes = await Promise.all(
    Array.from({ length: 12 }, () => limit.consume('concurrent', { window: 60, max: 3 })),
  );
  expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(3);
  expect(
    outcomes.filter((outcome) => !outcome.allowed && (outcome.retryAfter ?? 0) > 0),
  ).toHaveLength(9);
});

it('keeps the limit active for one full window after the last accepted attempt', async () => {
  await using fixture = await openAuthFixture();
  const limit = createAuthRateLimit({ redis: fixture.redis, prefix: fixture.prefix });
  expect((await limit.consume('rolling-window', { window: 2, max: 2 })).allowed).toBe(true);
  await setTimeout(1_100);
  expect((await limit.consume('rolling-window', { window: 2, max: 2 })).allowed).toBe(true);
  await setTimeout(1_100);
  expect((await limit.consume('rolling-window', { window: 2, max: 2 })).allowed).toBe(false);
});

async function openAuthFixture() {
  const prefix = `auth-test-${randomUUID()}`;
  const email = `${prefix}@example.com`;
  const messages: EmailMessage[] = [];
  const verificationIds: string[] = [];
  const errors: Error[] = [];
  const onError = (error: Error) => {
    errors.push(error);
  };
  // Startup owns partial initialization; the returned scope takes over only after it succeeds.
  await using startup = new AsyncDisposableStack();
  const database = startup.use(openDatabase({ url: ENV.DATABASE_URL, onError }));
  const redis = startup.use(openRedis({ url: ENV.REDIS_URL, role: 'api', onError }));
  await redis.client.connect();
  const authentication = startup.use(
    createAuthentication({
      db: database.db,
      config: {
        name: 'Always On Test',
        baseUrl: BASE_URL,
        secret: 'integration-secret-at-least-thirty-two-characters',
        google: { clientId: 'google-test-client', clientSecret: 'google-test-secret' },
        github: { clientId: 'github-test-client', clientSecret: 'github-test-secret' },
      },
      sendEmail: async (message) => {
        messages.push(message);
      },
      rateLimit: createAuthRateLimit({ redis: redis.client, prefix }),
      onError,
    }),
  );
  const app = createApp({
    name: 'Test',
    authentication,
    checks: { database: database.check, redis: () => redis.client.ping() },
    onError,
  });
  const resources = startup.move();
  return {
    db: database.db,
    redis: redis.client,
    prefix,
    email,
    request,
    signUp,
    signIn,
    verifyEmail,
    readEmail,
    recordOAuthState,
    errors,
    [Symbol.asyncDispose]: dispose,
  };

  function request({
    path,
    method = 'POST',
    body,
    cookie,
    origin = BASE_URL,
  }: {
    path: string;
    method?: 'GET' | 'POST';
    body?: unknown;
    cookie?: string;
    origin?: string;
  }) {
    const headers = new Headers({ origin });
    if (cookie) headers.set('cookie', cookie);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return app.request(new URL(path, BASE_URL), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function signUp() {
    return request({
      path: '/api/auth/sign-up/email',
      body: { email, name: 'Test User', password: PASSWORD },
    });
  }

  function signIn(password: string) {
    return request({ path: '/api/auth/sign-in/email', body: { email, password } });
  }

  async function readEmail(subject: string) {
    return await vi.waitFor(() => {
      const message = messages.find((candidate) => candidate.subject.startsWith(subject));
      assert.ok(message, `Expected email with subject ${subject}`);
      return message;
    });
  }

  async function verifyEmail() {
    const message = await readEmail('Verify your email');
    const url = getMessageUrl(message);
    const response = await request({ path: `${url.pathname}${url.search}`, method: 'GET' });
    expect(response.status).toBe(302);
  }

  async function dispose() {
    await using _ownedResources = resources;
    await authentication[Symbol.asyncDispose]();
    await database.db
      .delete(AUTHENTICATION_TABLES.user)
      .where(eq(AUTHENTICATION_TABLES.user.email, email));
    if (verificationIds.length > 0)
      await database.db
        .delete(AUTHENTICATION_TABLES.verification)
        .where(inArray(AUTHENTICATION_TABLES.verification.identifier, verificationIds));
    const keys = await redis.client.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.client.del(...keys);
  }

  function recordOAuthState(state: string) {
    verificationIds.push(getAuthStateVerificationIdentifier(state));
  }
}

function getSessionCookie(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith('better-auth.session_token='));
  assert.ok(cookie, 'Expected a signed session cookie');
  return cookie.split(';')[0] ?? cookie;
}

function getMessageUrl(message: EmailMessage) {
  const link = message.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link, 'Expected a credential link in the test mailbox');
  return new URL(link);
}
