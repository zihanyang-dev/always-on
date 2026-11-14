import assert from 'node:assert/strict';
import { createAccessControl } from 'better-auth/plugins/access';
import { type OrganizationOptions, organization } from 'better-auth/plugins/organization';
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';
import { getTestInstance } from 'better-auth/test';
import { expect, it } from 'vitest';
import { z } from 'zod';

const BASE_URL = 'http://localhost:3001';
const PASSWORD = 'organization-research-password';
const ACCESS = createAccessControl({ ...defaultStatements, agent: ['run'] } as const);
// Characterize upstream defaults in isolated SQLite before drawing conclusions about Drizzle/PG.
const ROLES = {
  owner: ACCESS.newRole({ ...ownerAc.statements, agent: ['run'] }),
  admin: ACCESS.newRole({ ...adminAc.statements, agent: ['run'] }),
  member: ACCESS.newRole({ ...memberAc.statements, agent: ['run'] }),
  viewer: ACCESS.newRole({}),
} satisfies NonNullable<OrganizationOptions['roles']>;
const PERMISSION_RESPONSE_SCHEMA = z.object({ success: z.boolean() });

it('returns HTTP 200 with a denied permission and resolves capabilities within the requested organization', async () => {
  const fixture = await openOrganizationFixture();
  const workspace = await fixture.createWorkspace('first');
  const secondWorkspace = await fixture.createWorkspace('second');
  const viewer = await fixture.createUser('viewer@example.com');
  await fixture.auth.api.addMember({
    body: { organizationId: workspace.id, userId: viewer.user.id, role: 'viewer' },
  });
  const denied = await fixture.request({
    path: 'has-permission',
    headers: viewer.headers,
    body: { organizationId: workspace.id, permissions: { agent: ['run'] } },
  });
  expect(denied.status).toBe(200);
  expect(PERMISSION_RESPONSE_SCHEMA.parse(await denied.json()).success).toBe(false);
  const foreign = await fixture.request({
    path: 'has-permission',
    headers: viewer.headers,
    body: { organizationId: secondWorkspace.id, permissions: { agent: ['run'] } },
  });
  expect(foreign.status).toBe(401);
  const ownerPermission = await fixture.auth.api.hasPermission({
    headers: fixture.owner.headers,
    body: { organizationId: workspace.id, permissions: { agent: ['run'] } },
  });
  expect(ownerPermission.success).toBe(true);
});

it('requires a verified recipient and consumes an invitation only once', async () => {
  const fixture = await openOrganizationFixture();
  const workspace = await fixture.createWorkspace('invitation');
  const recipient = await fixture.createUser('recipient@example.com');
  const invitation = await fixture.auth.api.createInvitation({
    headers: fixture.owner.headers,
    body: { organizationId: workspace.id, email: recipient.user.email, role: 'member' },
  });
  const input = {
    path: 'accept-invitation',
    headers: recipient.headers,
    body: { invitationId: invitation.id },
  };
  expect((await fixture.request(input)).status).toBe(403);
  // Only the isolated SDK fixture is changed; verification delivery is covered by app integration tests.
  await fixture.db.update({
    model: 'user',
    where: [{ field: 'id', value: recipient.user.id }],
    update: { emailVerified: true },
  });
  expect((await fixture.request(input)).status).toBe(200);
  expect((await fixture.request(input)).status).toBe(400);
  expect(
    await fixture.db.count({
      model: 'member',
      where: [
        { field: 'organizationId', value: workspace.id },
        { field: 'userId', value: recipient.user.id },
      ],
    }),
  ).toBe(1);
});

it('retains the organization when the initial owner hook fails', async () => {
  const fixture = await openOrganizationFixture({
    beforeAddMember: async () => {
      throw new Error('Injected initial owner failure');
    },
  });
  const response = await fixture.request({
    path: 'create',
    headers: fixture.owner.headers,
    body: { name: 'Incomplete workspace', slug: 'incomplete' },
  });
  expect(response.status).toBe(500);
  expect(await fixture.db.count({ model: 'organization' })).toBe(1);
  expect(await fixture.db.count({ model: 'member' })).toBe(0);
});

it('allows two pre-authorized owners to remove each other without a database invariant', async () => {
  const meet = createBarrier(2);
  const fixture = await openOrganizationFixture({ beforeRemoveMember: meet });
  const workspace = await fixture.createWorkspace('owners');
  const secondOwner = await fixture.createUser('second-owner@example.com');
  await fixture.auth.api.addMember({
    body: { organizationId: workspace.id, userId: secondOwner.user.id, role: 'owner' },
  });
  // Both requests finish the SDK's owner-count check before either may delete a membership.
  const outcomes = await Promise.all([
    fixture.request({
      path: 'remove-member',
      headers: fixture.owner.headers,
      body: { organizationId: workspace.id, memberIdOrEmail: secondOwner.user.email },
    }),
    fixture.request({
      path: 'remove-member',
      headers: secondOwner.headers,
      body: { organizationId: workspace.id, memberIdOrEmail: fixture.owner.user.email },
    }),
  ]);
  expect(outcomes.map((response) => response.status)).toEqual([200, 200]);
  expect(
    await fixture.db.count({
      model: 'member',
      where: [{ field: 'organizationId', value: workspace.id }],
    }),
  ).toBe(0);
});

it('accepts an existing invitation after its inviter has left unless the application adds a guard', async () => {
  const fixture = await openOrganizationFixture();
  const workspace = await fixture.createWorkspace('departed-inviter');
  const secondOwner = await fixture.createUser('remaining-owner@example.com');
  const recipient = await fixture.createUser('invited@example.com');
  await fixture.auth.api.addMember({
    body: { organizationId: workspace.id, userId: secondOwner.user.id, role: 'owner' },
  });
  const invitation = await fixture.auth.api.createInvitation({
    headers: fixture.owner.headers,
    body: { organizationId: workspace.id, email: recipient.user.email, role: 'member' },
  });
  await fixture.auth.api.removeMember({
    headers: secondOwner.headers,
    body: { organizationId: workspace.id, memberIdOrEmail: fixture.owner.user.email },
  });
  await fixture.db.update({
    model: 'user',
    where: [{ field: 'id', value: recipient.user.id }],
    update: { emailVerified: true },
  });
  const accepted = await fixture.request({
    path: 'accept-invitation',
    headers: recipient.headers,
    body: { invitationId: invitation.id },
  });
  expect(accepted.status).toBe(200);
});

async function openOrganizationFixture(
  organizationHooks: NonNullable<OrganizationOptions['organizationHooks']> = {},
) {
  // The public SDK helper owns an isolated in-memory SQLite database and closes it after the suite.
  // Its fast test password hash is deliberately confined to tests/sdk.
  const fixture = await getTestInstance({
    baseURL: BASE_URL,
    plugins: [
      organization({
        ac: ACCESS,
        roles: ROLES,
        requireEmailVerificationOnInvitation: true,
        organizationHooks,
      }),
    ],
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
  const owner = await fixture.signInWithTestUser();
  return { ...fixture, owner, createWorkspace, createUser, request };

  async function createWorkspace(slug: string) {
    const workspace = await fixture.auth.api.createOrganization({
      headers: owner.headers,
      body: { name: slug, slug },
    });
    assert.ok(workspace);
    return workspace;
  }

  async function createUser(email: string) {
    const { user } = await fixture.auth.api.signUpEmail({
      body: { name: email, email, password: PASSWORD },
    });
    const { headers } = await fixture.signInWithUser(email, PASSWORD);
    return { user, headers };
  }

  async function request({
    path,
    headers,
    body,
  }: {
    path: string;
    headers: Headers;
    body: Record<string, unknown>;
  }) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('content-type', 'application/json');
    requestHeaders.set('origin', BASE_URL);
    return await fixture.auth.handler(
      new Request(`${BASE_URL}/api/auth/organization/${path}`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
      }),
    );
  }
}

function createBarrier(participants: number) {
  const ready = Promise.withResolvers<void>();
  let arrivals = 0;
  return meet;

  async function meet() {
    arrivals += 1;
    if (arrivals === participants) ready.resolve();
    await ready.promise;
  }
}
