import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import {
  type AccessClient,
  type AccessFixture,
  expectStatus,
  GOOGLE_CLIENT_ID,
  ORIGIN,
  objectField,
  PASSWORD,
  responseBody,
  responseCookies,
  textField,
  withAccessFixture,
} from './access-fixture.ts';

test('Authentication against PostgreSQL', async (suite) => {
  await withAccessFixture(async (fixture) => {
    await suite.test(
      'advertises configured login methods and accepts a GitHub callback',
      (context) => verifyGitHubLogin(fixture, context),
    );

    await suite.test(
      'verifies Google identity and refuses implicit cross-provider linking',
      (context) => verifyGoogleLogin(fixture, context),
    );

    await suite.test('email password reset revokes existing sessions', () =>
      verifyPasswordReset(fixture),
    );
  });
});

async function verifyGitHubLogin({ db, request }: AccessFixture, context: TestContext) {
  assert.deepEqual(await (await request('/api/login-methods')).json(), {
    methods: ['email-password', 'github', 'google'],
  });

  const github = await startOAuth(request, { provider: 'github', hostname: 'github.com' });
  const state = textField(github.url.searchParams.get('state'));

  context.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input);
    switch (url) {
      case 'https://github.com/login/oauth/access_token':
        return Response.json({ access_token: 'mock-provider-token', token_type: 'bearer' });
      case 'https://api.github.com/user':
        return Response.json({ id: 123, login: 'mock-user', email: 'oauth@example.test' });
      case 'https://api.github.com/user/emails':
        return Response.json([{ email: 'oauth@example.test', primary: true, verified: true }]);
      default:
        throw new Error(`Unexpected provider request to ${new URL(url).hostname}`);
    }
  });

  const callback = await request(
    `/api/auth/callback/github?code=test-code&state=${encodeURIComponent(state)}`,
    {
      cookie: github.cookie,
    },
  );
  await expectStatus(callback, 302);
  assert.equal(callback.headers.get('location'), `${ORIGIN}/`);

  const me = await request('/api/me', { cookie: responseCookies(callback) });
  await expectStatus(me, 200);
  const user = objectField((await responseBody(me)).user);
  assert.equal(user.email, 'oauth@example.test');
  assert.equal(user.emailVerified, true);

  const account = await db
    .selectFrom('auth_accounts')
    .select(['account_id', 'access_token'])
    .where('user_id', '=', textField(user.id))
    .where('provider_id', '=', 'github')
    .executeTakeFirstOrThrow();
  assert.equal(account.account_id, '123');
  assert.ok(account.access_token);
  assert.notEqual(account.access_token, 'mock-provider-token');
}

async function verifyGoogleLogin({ db, request }: AccessFixture, context: TestContext) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'google-test-key',
    alg: 'RS256',
  };
  let profile = { email: 'google@example.test', sub: 'google-user' };

  context.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({
        access_token: 'google-provider-test-token',
        token_type: 'Bearer',
        id_token: googleIdToken(privateKey, profile),
      });
    }
    throw new Error(`Unexpected provider request to ${new URL(url).hostname}`);
  });

  const callback = await signInWithGoogle();
  assert.equal(callback.headers.get('location'), `${ORIGIN}/`);
  const me = await request('/api/me', { cookie: responseCookies(callback) });
  await expectStatus(me, 200);
  const user = objectField((await responseBody(me)).user);
  assert.equal(user.email, profile.email);
  assert.equal(user.emailVerified, true);
  const googleAccount = await db
    .selectFrom('auth_accounts')
    .select('account_id')
    .where('user_id', '=', textField(user.id))
    .where('provider_id', '=', 'google')
    .executeTakeFirstOrThrow();
  assert.equal(googleAccount.account_id, profile.sub);

  // This email already belongs to the GitHub user from the previous case.
  profile = { email: 'oauth@example.test', sub: 'another-google-user' };
  const refused = await signInWithGoogle();
  const redirect = new URL(textField(refused.headers.get('location')), ORIGIN);
  assert.ok(redirect.searchParams.has('error'));
  const link = await db
    .selectFrom('auth_accounts')
    .select('id')
    .where('provider_id', '=', 'google')
    .where('account_id', '=', profile.sub)
    .executeTakeFirst();
  assert.equal(link, undefined);

  async function signInWithGoogle() {
    const start = await startOAuth(request, {
      provider: 'google',
      hostname: 'accounts.google.com',
      ip: 7,
    });
    const query = new URLSearchParams({
      code: 'test-code',
      state: textField(start.url.searchParams.get('state')),
    });
    const callback = await request(`/api/auth/callback/google?${query}`, {
      cookie: start.cookie,
      ip: 7,
    });
    await expectStatus(callback, 302);
    return callback;
  }
}

async function verifyPasswordReset({ db, request, register, receivedLink }: AccessFixture) {
  const email = 'reset@example.test';
  const { cookie, userId } = await register({ email, ip: 2 });
  const account = await db
    .selectFrom('auth_accounts')
    .select('password')
    .where('user_id', '=', userId)
    .where('provider_id', '=', 'credential')
    .executeTakeFirstOrThrow();
  assert.ok(account.password);
  assert.notEqual(account.password, PASSWORD);

  await expectStatus(
    await request('/api/auth/request-password-reset', {
      method: 'POST',
      ip: 2,
      body: { email, redirectTo: ORIGIN },
    }),
    200,
  );

  const token = receivedLink(email).pathname.split('/').at(-1);
  assert.ok(token);
  await expectStatus(
    await request('/api/auth/reset-password', {
      method: 'POST',
      ip: 2,
      body: { token, newPassword: 'changed-password-123' },
    }),
    200,
  );
  await expectStatus(await request('/api/me', { cookie }), 401);
  await expectStatus(
    await request('/api/auth/sign-in/email', {
      method: 'POST',
      ip: 2,
      body: { email, password: PASSWORD },
    }),
    401,
  );
}

async function startOAuth(
  request: AccessClient,
  { provider, hostname, ip = 1 }: { provider: 'github' | 'google'; hostname: string; ip?: number },
) {
  const response = await request('/api/auth/sign-in/social', {
    method: 'POST',
    ip,
    body: { provider, callbackURL: `${ORIGIN}/` },
  });
  await expectStatus(response, 200);
  const url = new URL(textField((await responseBody(response)).url));
  assert.equal(url.hostname, hostname);
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/api/auth/callback/${provider}`);
  return { url, cookie: responseCookies(response) };
}

function googleIdToken(key: KeyObject, profile: { email: string; sub: string }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'google-test-key', typ: 'JWT' };
  const claims = {
    ...profile,
    name: 'Google User',
    email_verified: true,
    iss: 'https://accounts.google.com',
    aud: GOOGLE_CLIENT_ID,
    iat: now,
    exp: now + 600,
  };
  const unsigned = [header, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
}
