import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import type { ModelCatalog } from '@always-on/contracts/models';
import { convertSetCookieToCookie } from 'better-auth/test';
import { eq, inArray } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import { hasWorkspaceAgents } from '../../apps/server/src/agents/index.js';
import { createApp } from '../../apps/server/src/bootstrap/app.js';
import { parseWorkerEnv } from '../../apps/server/src/bootstrap/env.js';
import {
  createAuthentication,
  createAuthRateLimit,
} from '../../apps/server/src/infrastructure/authentication/index.js';
import {
  AGENT_SESSIONS,
  AGENTS,
  AUTHENTICATION_TABLES,
  type Database,
  INBOX_EVENTS,
  openDatabase,
  WORKSPACE_TABLES,
} from '../../apps/server/src/infrastructure/database/index.js';
import type { EmailMessage } from '../../apps/server/src/infrastructure/email/index.js';
import { openRedis } from '../../apps/server/src/infrastructure/redis/index.js';
import {
  type AgentWorkerResource,
  openAgentWorker,
  type RunExecutor,
} from '../../apps/server/src/tasks/index.js';
import { createWorkspacePlugin } from '../../apps/server/src/workspaces/index.js';

const ENV = parseWorkerEnv(process.env);
const BASE_URL = 'http://localhost:3001';
const PASSWORD = 'workspace-integration-password';
const PROFILE_RESPONSE_SCHEMA = z.object({ user: z.object({ id: z.string(), email: z.email() }) });
const WORKSPACE_RESPONSE_SCHEMA = z.object({ id: z.string(), name: z.string(), slug: z.string() });
const INVITATION_RESPONSE_SCHEMA = z.object({
  id: z.string(),
  email: z.email(),
  status: z.string(),
});
const MEMBER_RESPONSE_SCHEMA = z.object({ id: z.string(), userId: z.string(), role: z.string() });

type WorkspaceActor = { id: string; email: string; headers: Headers; clientIp: string };
/** One HTTP request through the application fixture, with optional real login credentials. */
export type WorkspaceRequest = {
  path: string;
  actor?: WorkspaceActor;
  body?: unknown;
  method?: 'GET' | 'POST' | 'PATCH';
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  origin?: string;
  clientIp?: string;
};
/** Application dependencies and identities owned by a workspace integration scenario. */
export interface WorkspaceFixture extends AsyncDisposable {
  readonly db: Database;
  readonly startWorker: (
    execute: RunExecutor,
    options?: { createId?: () => string },
  ) => Promise<AgentWorkerResource>;
  readonly request: (input: WorkspaceRequest) => Promise<Response>;
  readonly createActor: (label: string) => Promise<WorkspaceActor>;
  readonly createWorkspace: (input: {
    actor: WorkspaceActor;
    label: string;
  }) => Promise<z.infer<typeof WORKSPACE_RESPONSE_SCHEMA>>;
  readonly readEmail: (input: { to: string; subject: string }) => Promise<EmailMessage>;
  readonly expectErrors: (messages: readonly string[]) => void;
  readonly invite: (input: {
    actor: WorkspaceActor;
    organizationId: string;
    email: string;
    role: string;
    resend?: boolean;
  }) => Promise<z.infer<typeof INVITATION_RESPONSE_SCHEMA>>;
  readonly join: (input: {
    actor: WorkspaceActor;
    organizationId: string;
    recipient: WorkspaceActor;
    role: string;
  }) => Promise<z.infer<typeof MEMBER_RESPONSE_SCHEMA>>;
}

/** Owns real application resources and deletes only records created by this fixture. */
export async function openWorkspaceFixture({
  catalog,
}: {
  catalog?: ModelCatalog;
} = {}): Promise<WorkspaceFixture> {
  const prefix = `workspace-test-${randomUUID()}`;
  const emails: string[] = [];
  const slugs: string[] = [];
  const messages: EmailMessage[] = [];
  const failures: Error[] = [];
  const requests = new Set<Promise<Response>>();
  let isClosing = false;
  const onError = (error: Error) => failures.push(error);
  const sendEmail = async (message: EmailMessage) => {
    messages.push(message);
  };
  await using startup = new AsyncDisposableStack();
  startup.defer(assertNoDependencyFailures);
  const database = startup.use(openDatabase({ url: ENV.DATABASE_URL, onError }));
  const redis = startup.use(openRedis({ url: ENV.REDIS_URL, role: 'api', onError }));
  await redis.client.connect();
  // Disposal drains SDK work before deleting test records, then closes Redis and PostgreSQL.
  startup.defer(deleteRecords);
  const authentication = startup.use(
    createAuthentication({
      db: database.db,
      config: {
        name: 'Workspace Test',
        baseUrl: BASE_URL,
        secret: 'workspace-test-secret-at-least-thirty-two-characters',
        google: undefined,
        github: undefined,
      },
      sendEmail,
      plugins: [
        createWorkspacePlugin({
          baseUrl: BASE_URL,
          sendEmail,
          canDeleteWorkspace: async (workspaceId) =>
            !(await hasWorkspaceAgents({ db: database.db, workspaceId })),
        }),
      ],
      rateLimit: createAuthRateLimit({ redis: redis.client, prefix }),
      onError,
    }),
  );
  const app = createApp({
    name: 'Workspace Test',
    checks: { database: database.check, redis: () => redis.client.ping() },
    authentication,
    onError,
    ...(catalog
      ? {
          execution: {
            db: database.db,
            catalog,
            events: { redisUrl: ENV.REDIS_URL, prefix },
          },
        }
      : {}),
  });
  const resources = startup.move();
  return {
    db: database.db,
    startWorker,
    request,
    createActor,
    createWorkspace,
    readEmail,
    expectErrors,
    invite,
    join,
    [Symbol.asyncDispose]: dispose,
  };

  async function request(input: WorkspaceRequest) {
    if (isClosing) throw new Error('Workspace fixture is closing');
    const response = sendRequest(input);
    requests.add(response);
    try {
      return await response;
    } finally {
      requests.delete(response);
    }
  }

  async function sendRequest({
    path,
    actor,
    body,
    method = 'POST',
    origin = BASE_URL,
    clientIp = actor?.clientIp ?? '192.0.2.1',
    headers: extraHeaders,
    signal,
  }: WorkspaceRequest) {
    const headers = new Headers(actor?.headers);
    for (const [name, value] of Object.entries(extraHeaders ?? {})) headers.set(name, value);
    headers.set('origin', origin);
    if (body !== undefined) headers.set('content-type', 'application/json');
    // Model distinct socket peers; untrusted forwarding headers cannot supply this identity.
    await using socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: clientIp });
    return await app.request(
      new URL(path, BASE_URL),
      {
        method,
        headers,
        ...(signal ? { signal } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { incoming: new IncomingMessage(socket) },
    );
  }

  async function createActor(label: string) {
    const email = `${prefix}-${label}@example.com`;
    // Register ownership before a write so partial failures remain covered by teardown.
    emails.push(email);
    const clientIp = `192.0.2.${emails.length + 1}`;
    const signup = await request({
      path: '/api/auth/sign-up/email',
      body: { email, name: label, password: PASSWORD },
      clientIp,
    });
    expect(signup.status).toBe(200);
    const { user } = PROFILE_RESPONSE_SCHEMA.parse(await signup.json());
    const verification = await readEmail({ to: email, subject: 'Verify your email' });
    const verificationUrl = verification.text.match(/https?:\/\/\S+/)?.[0];
    assert.ok(verificationUrl, 'Expected a verification link in the test mailbox');
    expect((await request({ path: verificationUrl, method: 'GET', clientIp })).status).toBe(302);
    const signedIn = await request({
      path: '/api/auth/sign-in/email',
      body: { email, password: PASSWORD },
      clientIp,
    });
    expect(signedIn.status).toBe(200);
    return { ...user, headers: convertSetCookieToCookie(signedIn.headers), clientIp };
  }

  async function createWorkspace({ actor, label }: { actor: WorkspaceActor; label: string }) {
    const slug = `${prefix}-${label}`;
    slugs.push(slug);
    const response = await request({
      path: '/api/auth/organization/create',
      actor,
      body: { name: label, slug },
    });
    expect(response.status).toBe(200);
    return WORKSPACE_RESPONSE_SCHEMA.parse(await response.json());
  }

  async function readEmail({ to, subject }: { to: string; subject: string }) {
    return await vi.waitFor(() => {
      const message = messages.findLast(
        (candidate) => candidate.to === to && candidate.subject.startsWith(subject),
      );
      assert.ok(message, `Expected ${subject} email for ${to}`);
      return message;
    });
  }

  async function invite({ actor, ...body }: Parameters<WorkspaceFixture['invite']>[0]) {
    const response = await request({ path: '/api/auth/organization/invite-member', actor, body });
    expect(response.status).toBe(200);
    return INVITATION_RESPONSE_SCHEMA.parse(await response.json());
  }

  async function join({
    actor,
    organizationId,
    recipient,
    role,
  }: Parameters<WorkspaceFixture['join']>[0]) {
    // Exercise the public invitation protocol rather than writing membership fixtures directly.
    const invitation = await invite({ actor, organizationId, email: recipient.email, role });
    const response = await request({
      path: '/api/auth/organization/accept-invitation',
      actor: recipient,
      body: { invitationId: invitation.id },
    });
    expect(response.status).toBe(200);
    return z.object({ member: MEMBER_RESPONSE_SCHEMA }).parse(await response.json()).member;
  }

  async function deleteRecords() {
    const outcomes = await Promise.allSettled([deleteDatabaseRecords(), deleteRateLimits()]);
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (errors.length > 0) throw new AggregateError(errors, 'Workspace fixture cleanup failed');
  }

  async function deleteDatabaseRecords() {
    if (slugs.length > 0) {
      const sessions = await database.db
        .select({ id: AGENT_SESSIONS.id })
        .from(AGENT_SESSIONS)
        .innerJoin(
          WORKSPACE_TABLES.organization,
          eq(AGENT_SESSIONS.workspaceId, WORKSPACE_TABLES.organization.id),
        )
        .where(inArray(WORKSPACE_TABLES.organization.slug, slugs));
      const workspaces = database.db
        .select({ id: WORKSPACE_TABLES.organization.id })
        .from(WORKSPACE_TABLES.organization)
        .where(inArray(WORKSPACE_TABLES.organization.slug, slugs));
      // Test teardown explicitly releases product records; public deletion must preserve their ownership.
      await database.db
        .delete(AGENT_SESSIONS)
        .where(inArray(AGENT_SESSIONS.workspaceId, workspaces));
      await database.db.delete(AGENTS).where(inArray(AGENTS.workspaceId, workspaces));
      await database.db
        .delete(WORKSPACE_TABLES.organization)
        .where(inArray(WORKSPACE_TABLES.organization.slug, slugs));
      if (sessions.length > 0)
        await database.db.delete(INBOX_EVENTS).where(
          inArray(
            INBOX_EVENTS.scopeId,
            sessions.map((session) => session.id),
          ),
        );
    }
    if (emails.length > 0)
      await database.db
        .delete(AUTHENTICATION_TABLES.user)
        .where(inArray(AUTHENTICATION_TABLES.user.email, emails));
  }

  function startWorker(
    execute: RunExecutor,
    { createId = randomUUID }: { createId?: () => string } = {},
  ) {
    return openAgentWorker({
      db: database.db,
      redisUrl: ENV.REDIS_URL,
      prefix,
      concurrency: 2,
      execute,
      createId,
      onError,
    });
  }

  async function deleteRateLimits() {
    const keys = await redis.client.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.client.del(...keys);
  }

  function assertNoDependencyFailures() {
    if (failures.length > 0)
      throw new AggregateError(failures, 'Workspace fixture dependencies failed');
  }

  function expectErrors(messages: readonly string[]) {
    // Tests that provoke a logged rejection must account for exactly those errors before disposal.
    expect(failures.map((error) => error.message)).toEqual(messages);
    failures.length = 0;
  }

  async function dispose() {
    // A failed Promise.all must not let sibling setup requests outlive their database cleanup.
    isClosing = true;
    await using _ownedResources = resources;
    const outcomes = await Promise.allSettled(requests);
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (errors.length > 0)
      throw new AggregateError(errors, 'Workspace fixture requests failed during shutdown');
  }
}
