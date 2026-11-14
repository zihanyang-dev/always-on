import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { type OrganizationOptions, organization } from 'better-auth/plugins/organization';
import { getTestInstance } from 'better-auth/test';
import { eq, inArray, sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { parseWorkerEnv } from '../../apps/server/src/bootstrap/env.js';
import {
  AUTHENTICATION_TABLES,
  DATABASE_SCHEMA,
  openDatabase,
  WORKSPACE_TABLES,
} from '../../apps/server/src/infrastructure/database/index.js';

const ENV = parseWorkerEnv(process.env);

// Fault and lock probes protect the versioned SDK patch against regressions during upgrades.
// Application permissions are covered through the production Hono/Redis composition.
it.each(['beforeAddMember', 'afterAddMember', 'afterCreateOrganization'] as const)(
  'rolls back organization and initial membership when %s fails on Drizzle/PG',
  async (hook) => {
    await using fixture = await openPgOrganizationFixture({ [hook]: fail });
    await expect(fixture.createWorkspace()).rejects.toThrow('Injected initial member failure');
    expect(await fixture.readWorkspaces()).toEqual([]);
    expect(await fixture.readMembers()).toEqual([]);

    async function fail() {
      throw new Error('Injected initial member failure');
    }
  },
);

it('serializes owner checks and rechecks the waiting callers membership before removing another owner', async () => {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await using fixture = await openPgOrganizationFixture({ beforeRemoveMember: meet });
  const workspace = await fixture.createWorkspace();
  const second = await fixture.createUser();
  await fixture.auth.api.addMember({
    body: { organizationId: workspace.id, userId: second.user.id, role: 'owner' },
  });
  const first = fixture.auth.api.removeMember({
    headers: fixture.owner.headers,
    body: { organizationId: workspace.id, memberIdOrEmail: second.user.email },
  });
  await ready.promise;
  const secondRemoval = fixture.auth.api.removeMember({
    headers: second.headers,
    body: { organizationId: workspace.id, memberIdOrEmail: fixture.owner.user.email },
  });
  const waiting = await Promise.allSettled([fixture.waitForBlockedMutation()]);
  // Always release the first transaction and settle both requests, even when the lock probe fails.
  release.resolve();
  const outcomes = await Promise.allSettled([first, secondRemoval]);
  expect(waiting).toMatchObject([{ status: 'fulfilled' }]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
  expect(outcomes.at(1)).toMatchObject({
    status: 'rejected',
    reason: { statusCode: 400, body: { code: 'MEMBER_NOT_FOUND' } },
  });
  expect(await fixture.readMembers()).toEqual([
    expect.objectContaining({ userId: fixture.owner.user.id, role: 'owner' }),
  ]);

  async function meet() {
    ready.resolve();
    await release.promise;
  }
});

it('rolls back cascading member and invitation deletion when PostgreSQL rejects deleting the workspace', async () => {
  await using fixture = await openPgOrganizationFixture();
  const workspace = await fixture.createWorkspace();
  await fixture.auth.api.createInvitation({
    headers: fixture.owner.headers,
    body: { organizationId: workspace.id, email: 'pending@example.com', role: 'member' },
  });
  // A fixture-owned restrictive FK fails at the final delete, after SDK cascade work has started.
  const blocker = sql.identifier(`workspace_delete_test_${randomUUID().replaceAll('-', '')}`);
  await using cleanup = new AsyncDisposableStack();
  await fixture.db.execute(
    sql`create table ${blocker} (workspace_id text references workspaces(id))`,
  );
  cleanup.defer(async () => {
    await fixture.db.execute(sql`drop table ${blocker}`);
  });
  await fixture.db.execute(sql`insert into ${blocker} values (${workspace.id})`);
  await expect(
    fixture.auth.api.deleteOrganization({
      headers: fixture.owner.headers,
      body: { organizationId: workspace.id },
    }),
  ).rejects.toThrow();
  expect(await fixture.readWorkspaces()).toHaveLength(1);
  expect(await fixture.readMembers()).toHaveLength(1);
  expect(
    await fixture.db.query.invitation.findMany({
      where: eq(WORKSPACE_TABLES.invitation.organizationId, workspace.id),
    }),
  ).toHaveLength(1);
});

it('releases a claimed invitation when membership creation fails on PostgreSQL', async () => {
  await using fixture = await openPgOrganizationFixture({
    beforeAcceptInvitation: deleteRecipient,
  });
  const workspace = await fixture.createWorkspace();
  const recipient = await fixture.createUser();
  await fixture.db
    .update(AUTHENTICATION_TABLES.user)
    .set({ emailVerified: true })
    .where(eq(AUTHENTICATION_TABLES.user.id, recipient.user.id));
  const invitation = await fixture.auth.api.createInvitation({
    headers: fixture.owner.headers,
    body: { organizationId: workspace.id, email: recipient.user.email, role: 'member' },
  });
  await expect(
    fixture.auth.api.acceptInvitation({
      headers: recipient.headers,
      body: { invitationId: invitation.id },
    }),
  ).rejects.toThrow();
  expect(
    (
      await fixture.db.query.invitation.findFirst({
        where: eq(WORKSPACE_TABLES.invitation.id, invitation.id),
      })
    )?.status,
  ).toBe('pending');
  expect(await fixture.readMembers()).toEqual([
    expect.objectContaining({ userId: fixture.owner.user.id }),
  ]);

  async function deleteRecipient({ user }: { user: { id: string } }) {
    // Model deletion by another process between identity resolution and the membership insert.
    await fixture.db
      .delete(AUTHENTICATION_TABLES.user)
      .where(eq(AUTHENTICATION_TABLES.user.id, user.id));
  }
});

async function openPgOrganizationFixture(
  organizationHooks: NonNullable<OrganizationOptions['organizationHooks']> = {},
) {
  const prefix = `workspace-sdk-${randomUUID()}`;
  const ownerEmail = `${prefix}@example.com`;
  const emails = [ownerEmail];
  const failures: Error[] = [];
  await using startup = new AsyncDisposableStack();
  startup.defer(() => {
    if (failures.length > 0) throw new AggregateError(failures, 'SDK PostgreSQL fixture failed');
  });
  const databaseUrl = new URL(ENV.DATABASE_URL);
  databaseUrl.searchParams.set('application_name', prefix);
  const database = startup.use(
    openDatabase({ url: databaseUrl.href, onError: (error) => failures.push(error) }),
  );
  startup.defer(deleteRecords);
  // The official helper supplies test users, cookies and its test-only password hash.
  // Override its database with the same adapter, schema and transaction setting as production.
  const fixture = await getTestInstance(
    {
      database: drizzleAdapter(database.db, {
        provider: 'pg',
        schema: DATABASE_SCHEMA,
        transaction: true,
      }),
      plugins: [organization({ organizationHooks, requireEmailVerificationOnInvitation: true })],
      logger: { disabled: true },
      telemetry: { enabled: false },
    },
    { testUser: { email: ownerEmail } },
  );
  const owner = await fixture.signInWithTestUser();
  const resources = startup.move();
  return {
    auth: fixture.auth,
    db: database.db,
    owner,
    createWorkspace,
    createUser,
    readWorkspaces,
    readMembers,
    waitForBlockedMutation,
    [Symbol.asyncDispose]: dispose,
  };

  async function createWorkspace() {
    const workspace = await fixture.auth.api.createOrganization({
      headers: owner.headers,
      body: { name: 'SDK fixture', slug: prefix },
    });
    assert.ok(workspace);
    return workspace;
  }

  async function createUser() {
    const email = `${prefix}-${emails.length}@example.com`;
    emails.push(email);
    const password = 'sdk-workspace-password';
    const { user } = await fixture.auth.api.signUpEmail({ body: { email, name: email, password } });
    const { headers } = await fixture.signInWithUser(email, password);
    return { user, headers };
  }

  function readWorkspaces() {
    return database.db.query.organization.findMany({
      where: eq(WORKSPACE_TABLES.organization.slug, prefix),
    });
  }

  async function readMembers() {
    const workspaces = await readWorkspaces();
    return database.db.query.member.findMany({
      where: inArray(
        WORKSPACE_TABLES.member.organizationId,
        workspaces.map((workspace) => workspace.id),
      ),
    });
  }

  async function waitForBlockedMutation() {
    await vi.waitFor(async () => {
      const blocked = await database.db.execute(sql`
        select pid from pg_stat_activity
        where application_name = ${prefix} and wait_event_type = 'Lock'
      `);
      expect(blocked.rows).toHaveLength(1);
    });
  }

  async function deleteRecords() {
    await database.db
      .delete(WORKSPACE_TABLES.organization)
      .where(eq(WORKSPACE_TABLES.organization.slug, prefix));
    await database.db
      .delete(AUTHENTICATION_TABLES.user)
      .where(inArray(AUTHENTICATION_TABLES.user.email, emails));
  }

  async function dispose() {
    await resources.disposeAsync();
  }
}
