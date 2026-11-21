import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { promisify } from 'node:util';
import pg from 'pg';
import { migrateDatabase } from '../../apps/server/migrations/run.ts';
import { createApp } from '../../apps/server/src/entrypoints/app.ts';
import { openDatabase } from '../../apps/server/src/infrastructure/database/index.ts';
import type { SendEmail } from '../../apps/server/src/infrastructure/index.ts';

export const ORIGIN = 'http://localhost:3001';
export const PASSWORD = 'integration-password-123';
export const GOOGLE_CLIENT_ID = 'google-test';
const run = promisify(execFile);

type ClientOptions = {
  method?: string;
  cookie?: string;
  body?: object | string;
  origin?: string;
  ip?: number;
  headers?: Record<string, string>;
};

export type AccessClient = ReturnType<typeof createClient>;
type AppOptions = Pick<Parameters<typeof createApp>[0], 'findWebhookConnection' | 'observability'>;
export type AccessFixture = {
  db: ReturnType<typeof openDatabase>;
  request: AccessClient;
  register: (input: { email: string; ip: number }) => Promise<{ userId: string; cookie: string }>;
  receivedLink: (email: string) => URL;
  databaseName: string;
  databaseUrl: string;
  observer: pg.Client;
};

export async function withAccessFixture(
  check: (fixture: AccessFixture) => Promise<void>,
  { defaultIsolation, ...appOptions }: AppOptions & { defaultIsolation?: 'repeatable read' } = {},
): Promise<void> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required for integration tests');

  const observer = new pg.Client({ connectionString });
  await observer.connect();
  const databaseName = `always_on_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await observer.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(connectionString);
    url.pathname = `/${databaseName}`;
    try {
      await migrateTestDatabase(url.href);
      if (defaultIsolation === 'repeatable read')
        await observer.query(
          `ALTER DATABASE "${databaseName}" SET default_transaction_isolation TO 'repeatable read'`,
        );

      await exerciseAccess({
        databaseName,
        databaseUrl: url.href,
        observer,
        check,
        appOptions,
      });
    } finally {
      await observer.query(`DROP DATABASE "${databaseName}"`);
    }
  } finally {
    await observer.end();
  }
}

async function migrateTestDatabase(databaseUrl: string) {
  await migrateDatabase(databaseUrl);
  await migrateDatabase(databaseUrl);
  await run('pnpm', ['--filter', '@always-on/server', 'db:types:check'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function exerciseAccess({
  databaseName,
  databaseUrl,
  observer,
  check,
  appOptions,
}: Pick<AccessFixture, 'databaseName' | 'databaseUrl' | 'observer'> & {
  check: (fixture: AccessFixture) => Promise<void>;
  appOptions: AppOptions;
}) {
  const mail: Parameters<SendEmail>[0][] = [];
  const errors: unknown[] = [];
  await using db = openDatabase(databaseUrl, (error) => errors.push(error));
  const app = createApp({
    db,
    config: {
      origin: ORIGIN,
      secret: 'integration-secret-with-more-than-32-chars',
      github: { clientId: 'github-test', clientSecret: 'github-test-secret' },
      google: { clientId: GOOGLE_CLIENT_ID, clientSecret: 'google-test-secret' },
    },
    sendEmail: async (message) => {
      mail.push(message);
    },
    reportError: (error) => errors.push(error),
    ...appOptions,
  });
  const request = createClient(app);

  await check({ db, request, register, receivedLink, databaseName, databaseUrl, observer });
  assert.deepEqual(errors, []);

  function receivedLink(email: string) {
    return findMailLink(mail, email);
  }

  async function register({ email, ip }: { email: string; ip: number }) {
    const signup = await request('/api/auth/sign-up/email', {
      method: 'POST',
      ip,
      body: { email, name: email, password: PASSWORD },
    });
    await expectStatus(signup, 200);

    const link = receivedLink(email);
    const verify = await request(link.pathname + link.search, { ip });
    await expectStatus(verify, 302);
    const redirect = new URL(textField(verify.headers.get('location')), ORIGIN);
    assert.equal(redirect.searchParams.has('error'), false);

    const login = await request('/api/auth/sign-in/email', {
      method: 'POST',
      ip,
      body: { email, password: PASSWORD },
    });
    await expectStatus(login, 200);

    const cookie = responseCookies(login);
    const me = await request('/api/me', { cookie });
    await expectStatus(me, 200);
    const user = objectField((await responseBody(me)).user);
    assert.equal(user.email, email);
    assert.equal(user.emailVerified, true);
    assert.deepEqual(Object.keys(user).sort(), ['email', 'emailVerified', 'id', 'image', 'name']);

    return { userId: textField(user.id), cookie };
  }
}

function createClient(app: ReturnType<typeof createApp>) {
  return async function request(
    path: string,
    {
      method = 'GET',
      cookie,
      body,
      origin = ORIGIN,
      ip = 1,
      headers: extraHeaders,
    }: ClientOptions = {},
  ): Promise<Response> {
    const headers = new Headers(extraHeaders);
    headers.set('Origin', origin);
    if (cookie) headers.set('Cookie', cookie);
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: `192.0.2.${ip}` });
    return app.request(new URL(path, ORIGIN), init, { incoming: new IncomingMessage(socket) });
  };
}

export async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status)
    assert.equal(response.status, status, await response.clone().text());
}

function findMailLink(mail: Parameters<SendEmail>[0][], recipient: string) {
  const message = mail.findLast(({ to }) => to === recipient);
  assert.ok(message, `Expected a message to ${recipient}`);
  return new URL(textField(message.text.match(/https?:\/\/\S+/)?.[0]));
}

export function responseCookies(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie);
  return cookie;
}

export async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return objectField(await response.json());
}

export function objectField(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function textField(value: unknown): string {
  assert.ok(typeof value === 'string');
  return value;
}
