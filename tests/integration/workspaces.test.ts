import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AUTHENTICATION_TABLES,
  WORKSPACE_TABLES,
} from '../../apps/server/src/infrastructure/database/index.js';
import { openWorkspaceFixture } from './workspace-fixture.js';

const ERROR_SCHEMA = z.object({ code: z.string() });
const PERMISSION_SCHEMA = z.object({ success: z.boolean() });
const MEMBERS_SCHEMA = z.object({
  members: z.array(z.object({ id: z.string(), userId: z.string(), role: z.string() })),
  total: z.number(),
});

describe('workspace identity and isolation', () => {
  it('requires a verified identity and creates the authenticated caller as owner', async () => {
    await using fixture = await openWorkspaceFixture();
    const [owner, other] = await Promise.all([
      fixture.createActor('owner'),
      fixture.createActor('other'),
    ]);
    const anonymous = await fixture.request({
      path: '/api/auth/organization/create',
      body: { name: 'Anonymous', slug: 'anonymous' },
    });
    expect(anonymous.status).toBe(401);

    // Simulate an existing OAuth identity whose provider has not verified its email.
    await fixture.db
      .update(AUTHENTICATION_TABLES.user)
      .set({ emailVerified: false })
      .where(eq(AUTHENTICATION_TABLES.user.id, other.id));
    const unverified = await fixture.request({
      path: '/api/auth/organization/create',
      actor: other,
      body: { name: 'Unverified', slug: `unverified-${other.id}` },
    });
    expect(unverified.status).toBe(403);
    expect(ERROR_SCHEMA.parse(await unverified.json()).code).toBe(
      'YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION',
    );

    const workspace = await fixture.createWorkspace({ actor: owner, label: 'identity' });
    const members = await fixture.request({
      path: `/api/auth/organization/list-members?organizationId=${workspace.id}`,
      actor: owner,
      method: 'GET',
    });
    expect(MEMBERS_SCHEMA.parse(await members.json()).members).toEqual([
      expect.objectContaining({ userId: owner.id, role: 'owner' }),
    ]);
    const foreign = await fixture.request({
      path: '/api/auth/organization/list',
      actor: other,
      method: 'GET',
    });
    expect(await foreign.json()).toEqual([]);
    const forgedActor = await fixture.request({
      path: '/api/auth/organization/update',
      actor: other,
      body: { organizationId: workspace.id, userId: owner.id, data: { name: 'Forged' } },
    });
    expect(forgedActor.status).toBe(400);
    expect(ERROR_SCHEMA.parse(await forgedActor.json()).code).toBe(
      'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION',
    );
    expect(
      (
        await fixture.db.query.organization.findFirst({
          where: eq(WORKSPACE_TABLES.organization.id, workspace.id),
        })
      )?.name,
    ).toBe('identity');
  });

  it('checks explicit workspace membership even when another workspace is active', async () => {
    await using fixture = await openWorkspaceFixture();
    const [owner, viewer] = await Promise.all([
      fixture.createActor('owner'),
      fixture.createActor('viewer'),
    ]);
    const first = await fixture.createWorkspace({ actor: owner, label: 'first' });
    const second = await fixture.createWorkspace({ actor: owner, label: 'second' });
    const viewerMembership = await fixture.join({
      actor: owner,
      organizationId: first.id,
      recipient: viewer,
      role: 'viewer',
    });
    const allowed = await fixture.request({
      path: `/api/auth/organization/get-organization?organizationId=${first.id}`,
      actor: viewer,
      method: 'GET',
    });
    expect(allowed.status).toBe(200);
    const denied = await fixture.request({
      path: '/api/auth/organization/has-permission',
      actor: viewer,
      body: { organizationId: second.id, permissions: { organization: ['update'] } },
    });
    expect(denied.status).toBe(401);
    const foreignRoleChange = await fixture.request({
      path: '/api/auth/organization/update-member-role',
      actor: owner,
      body: { organizationId: second.id, memberId: viewerMembership.id, role: 'admin' },
    });
    expect(foreignRoleChange.status).toBe(403);
    expect(ERROR_SCHEMA.parse(await foreignRoleChange.json()).code).toBe(
      'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER',
    );
    const foreignRemoval = await fixture.request({
      path: '/api/auth/organization/remove-member',
      actor: owner,
      body: { organizationId: second.id, memberIdOrEmail: viewerMembership.id },
    });
    expect(foreignRemoval.status).toBe(400);
    const selected = await fixture.request({
      path: '/api/auth/organization/set-active',
      actor: owner,
      body: { organizationId: second.id },
    });
    expect(selected.status).toBe(200);
    const updateFirst = await fixture.request({
      path: '/api/auth/organization/update',
      actor: owner,
      body: { organizationId: first.id, data: { name: 'First updated' } },
    });
    expect(updateFirst.status).toBe(200);
    const workspaces = await fixture.db
      .select()
      .from(WORKSPACE_TABLES.organization)
      .where(eq(WORKSPACE_TABLES.organization.id, second.id));
    expect(workspaces.at(0)?.name).toBe('second');
  });
});

describe('workspace roles', () => {
  it('enforces the four roles and preserves SDK role combinations', async () => {
    await using fixture = await openWorkspaceFixture();
    const [owner, admin, member, viewer] = await Promise.all([
      fixture.createActor('owner'),
      fixture.createActor('admin'),
      fixture.createActor('member'),
      fixture.createActor('viewer'),
    ]);
    const workspace = await fixture.createWorkspace({ actor: owner, label: 'roles' });
    const memberships = await Promise.all([
      fixture.join({ actor: owner, organizationId: workspace.id, recipient: admin, role: 'admin' }),
      fixture.join({
        actor: owner,
        organizationId: workspace.id,
        recipient: member,
        role: 'member',
      }),
      fixture.join({
        actor: owner,
        organizationId: workspace.id,
        recipient: viewer,
        role: 'viewer',
      }),
    ]);
    for (const { actor, canUpdate, canDelete } of [
      { actor: owner, canUpdate: true, canDelete: true },
      { actor: admin, canUpdate: true, canDelete: false },
      { actor: member, canUpdate: false, canDelete: false },
      { actor: viewer, canUpdate: false, canDelete: false },
    ]) {
      for (const { action, expected } of [
        { action: 'update', expected: canUpdate },
        { action: 'delete', expected: canDelete },
      ]) {
        const permission = await fixture.request({
          path: '/api/auth/organization/has-permission',
          actor,
          body: { organizationId: workspace.id, permissions: { organization: [action] } },
        });
        expect(permission.status).toBe(200);
        expect(PERMISSION_SCHEMA.parse(await permission.json()).success).toBe(expected);
      }
      const listing = await fixture.request({
        path: `/api/auth/organization/list-members?organizationId=${workspace.id}`,
        actor,
        method: 'GET',
      });
      expect(listing.status).toBe(200);
      expect(MEMBERS_SCHEMA.parse(await listing.json()).total).toBe(4);
    }
    const viewerMembership = memberships.at(2);
    assert.ok(viewerMembership);
    const combination = await fixture.request({
      path: '/api/auth/organization/update-member-role',
      actor: owner,
      body: {
        organizationId: workspace.id,
        memberId: viewerMembership.id,
        role: ['viewer', 'admin'],
      },
    });
    expect(combination.status).toBe(200);
    const combinedPermission = await fixture.request({
      path: '/api/auth/organization/has-permission',
      actor: viewer,
      body: { organizationId: workspace.id, permissions: { invitation: ['create'] } },
    });
    expect(PERMISSION_SCHEMA.parse(await combinedPermission.json()).success).toBe(true);
    const ownerMember = await fixture.db.query.member.findFirst({
      where: and(
        eq(WORKSPACE_TABLES.member.organizationId, workspace.id),
        eq(WORKSPACE_TABLES.member.userId, owner.id),
      ),
    });
    assert.ok(ownerMember);
    const ownerDemotion = await fixture.request({
      path: '/api/auth/organization/update-member-role',
      actor: admin,
      body: { organizationId: workspace.id, memberId: ownerMember.id, role: 'member' },
    });
    expect(ownerDemotion.status).toBe(403);
    const adminDeletion = await fixture.request({
      path: '/api/auth/organization/delete',
      actor: admin,
      body: { organizationId: workspace.id },
    });
    expect(adminDeletion.status).toBe(403);
  });

  it('applies role changes and removal to existing login sessions immediately', async () => {
    await using fixture = await openWorkspaceFixture();
    const [owner, admin] = await Promise.all([
      fixture.createActor('owner'),
      fixture.createActor('admin'),
    ]);
    const workspace = await fixture.createWorkspace({ actor: owner, label: 'revocation' });
    const membership = await fixture.join({
      actor: owner,
      organizationId: workspace.id,
      recipient: admin,
      role: 'admin',
    });
    const demoted = await fixture.request({
      path: '/api/auth/organization/update-member-role',
      actor: owner,
      body: { organizationId: workspace.id, memberId: membership.id, role: 'viewer' },
    });
    expect(demoted.status).toBe(200);
    const revoked = await fixture.request({
      path: '/api/auth/organization/update',
      actor: admin,
      body: { organizationId: workspace.id, data: { name: 'Revoked' } },
    });
    expect(revoked.status).toBe(403);
    const removal = await fixture.request({
      path: '/api/auth/organization/remove-member',
      actor: owner,
      body: { organizationId: workspace.id, memberIdOrEmail: membership.id },
    });
    expect(removal.status).toBe(200);
    const removed = await fixture.request({
      path: `/api/auth/organization/list-members?organizationId=${workspace.id}`,
      actor: admin,
      method: 'GET',
    });
    expect(removed.status).toBe(403);
  });
});

describe('workspace invitations', () => {
  it('delivers a recipient-bound seven-day invitation and accepts it only once under concurrency', async () => {
    await using fixture = await openWorkspaceFixture();
    const [owner, recipient, stranger] = await Promise.all([
      fixture.createActor('owner'),
      fixture.createActor('recipient'),
      fixture.createActor('stranger'),
    ]);
    const workspace = await fixture.createWorkspace({ actor: owner, label: 'invitations' });
    const requestedAtMs = Date.now();
    const invitation = await fixture.invite({
      actor: owner,
      organizationId: workspace.id,
      email: recipient.email,
      role: 'viewer',
    });
    const acknowledgedAtMs = Date.now();
    const message = await fixture.readEmail({
      to: recipient.email,
      subject: `Join ${workspace.name}`,
    });
    const link = message.text.match(/https?:\/\/\S+/)?.[0];
    assert.ok(link);
    const invitationUrl = new URL(link);
    expect(invitationUrl.pathname).toBe('/api/auth/organization/get-invitation');
    expect(invitationUrl.searchParams.get('id')).toBe(invitation.id);
    const stored = await fixture.db.query.invitation.findFirst({
      where: eq(WORKSPACE_TABLES.invitation.id, invitation.id),
    });
    assert.ok(stored);
    // The SDK reads the clock separately for expiry and creation; assert the policy at its request boundary.
    const validityMs = 7 * 24 * 60 * 60 * 1_000;
    expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(requestedAtMs + validityMs);
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(acknowledgedAtMs + validityMs);
    const details = await fixture.request({ path: link, actor: recipient, method: 'GET' });
    expect(details.status).toBe(200);
    expect(
      (
        await fixture.db.query.invitation.findFirst({
          where: eq(WORKSPACE_TABLES.invitation.id, invitation.id),
        })
      )?.status,
    ).toBe('pending');
    const wrongRecipient = await fixture.request({
      path: '/api/auth/organization/accept-invitation',
      actor: stranger,
      body: { invitationId: invitation.id },
    });
    expect(wrongRecipient.status).toBe(403);
    const input = {
      path: '/api/auth/organization/accept-invitation',
      actor: recipient,
      body: { invitationId: invitation.id },
    };
    const outcomes = await Promise.all([fixture.request(input), fixture.request(input)]);
    expect(outcomes.map((response) => response.status).toSorted()).toEqual([200, 400]);
    expect((await fixture.request(input)).status).toBe(400);
    const membership = await fixture.db
      .select()
      .from(WORKSPACE_TABLES.member)
      .where(
        and(
          eq(WORKSPACE_TABLES.member.organizationId, workspace.id),
          eq(WORKSPACE_TABLES.member.userId, recipient.id),
        ),
      );
    expect(membership).toEqual([expect.objectContaining({ role: 'viewer' })]);
  });

  it('requires verified email at invitation review and acceptance', async () => {
    await using fixture = await openWorkspaceFixture();
    const [owner, recipient] = await Promise.all([
      fixture.createActor('owner'),
      fixture.createActor('recipient'),
    ]);
    const workspace = await fixture.createWorkspace({ actor: owner, label: 'verification' });
    const invitation = await fixture.invite({
      actor: owner,
      organizationId: workspace.id,
      email: recipient.email,
      role: 'member',
    });
    await fixture.db
      .update(AUTHENTICATION_TABLES.user)
      .set({ emailVerified: false })
      .where(eq(AUTHENTICATION_TABLES.user.id, recipient.id));
    const review = await fixture.request({
      path: `/api/auth/organization/get-invitation?id=${invitation.id}`,
      actor: recipient,
      method: 'GET',
    });
    expect(review.status).toBe(403);
    const accept = await fixture.request({
      path: '/api/auth/organization/accept-invitation',
      actor: recipient,
      body: { invitationId: invitation.id },
    });
    expect(accept.status).toBe(403);
    expect(ERROR_SCHEMA.parse(await accept.json()).code).toBe(
      'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION',
    );
    expect(
      (
        await fixture.db.query.invitation.findFirst({
          where: eq(WORKSPACE_TABLES.invitation.id, invitation.id),
        })
      )?.status,
    ).toBe('pending');
  });

  it('supports cancellation, rejection, expiration and explicit resend without granting membership', async () => {
    await using fixture = await openWorkspaceFixture();
    const [owner, recipient] = await Promise.all([
      fixture.createActor('owner'),
      fixture.createActor('recipient'),
    ]);
    const workspace = await fixture.createWorkspace({
      actor: owner,
      label: 'invitation-lifecycle',
    });
    const invite = () =>
      fixture.invite({
        actor: owner,
        organizationId: workspace.id,
        email: recipient.email,
        role: 'member',
      });
    const cancelled = await invite();
    const cancellation = await fixture.request({
      path: '/api/auth/organization/cancel-invitation',
      actor: owner,
      body: { invitationId: cancelled.id },
    });
    expect(cancellation.status).toBe(200);
    const cancelledAcceptance = await fixture.request({
      path: '/api/auth/organization/accept-invitation',
      actor: recipient,
      body: { invitationId: cancelled.id },
    });
    expect(cancelledAcceptance.status).toBe(400);
    const rejected = await invite();
    const rejection = await fixture.request({
      path: '/api/auth/organization/reject-invitation',
      actor: recipient,
      body: { invitationId: rejected.id },
    });
    expect(rejection.status).toBe(200);
    const expiring = await invite();
    const originalDeadline = new Date(Date.now() + 60_000);
    await fixture.db
      .update(WORKSPACE_TABLES.invitation)
      .set({ expiresAt: originalDeadline })
      .where(eq(WORKSPACE_TABLES.invitation.id, expiring.id));
    const resent = await fixture.invite({
      actor: owner,
      organizationId: workspace.id,
      email: recipient.email,
      role: 'member',
      resend: true,
    });
    expect(resent.status).toBe('pending');
    expect(resent.id).toBe(expiring.id);
    const refreshed = await fixture.db.query.invitation.findFirst({
      where: eq(WORKSPACE_TABLES.invitation.id, resent.id),
    });
    assert.ok(refreshed);
    expect(refreshed.expiresAt.getTime()).toBeGreaterThan(originalDeadline.getTime());
    await fixture.db
      .update(WORKSPACE_TABLES.invitation)
      .set({ expiresAt: new Date('2020-01-01') })
      .where(eq(WORKSPACE_TABLES.invitation.id, resent.id));
    const expiredAcceptance = await fixture.request({
      path: '/api/auth/organization/accept-invitation',
      actor: recipient,
      body: { invitationId: resent.id },
    });
    expect(expiredAcceptance.status).toBe(400);
    const replacement = await invite();
    const replacementAcceptance = await fixture.request({
      path: '/api/auth/organization/accept-invitation',
      actor: recipient,
      body: { invitationId: replacement.id },
    });
    expect(replacementAcceptance.status).toBe(200);
  });

  it('denies invitation management to members and viewers', async () => {
    await using fixture = await openWorkspaceFixture();
    const [owner, member, viewer] = await Promise.all([
      fixture.createActor('owner'),
      fixture.createActor('member'),
      fixture.createActor('viewer'),
    ]);
    const workspace = await fixture.createWorkspace({
      actor: owner,
      label: 'invitation-permissions',
    });
    await Promise.all([
      fixture.join({
        actor: owner,
        organizationId: workspace.id,
        recipient: member,
        role: 'member',
      }),
      fixture.join({
        actor: owner,
        organizationId: workspace.id,
        recipient: viewer,
        role: 'viewer',
      }),
    ]);
    const pending = await fixture.invite({
      actor: owner,
      organizationId: workspace.id,
      email: `${owner.id}@example.com`,
      role: 'member',
    });
    for (const actor of [member, viewer]) {
      const invite = await fixture.request({
        path: '/api/auth/organization/invite-member',
        actor,
        body: { organizationId: workspace.id, email: 'new@example.com', role: 'member' },
      });
      expect(invite.status).toBe(403);
      const cancel = await fixture.request({
        path: '/api/auth/organization/cancel-invitation',
        actor,
        body: { invitationId: pending.id },
      });
      expect(cancel.status).toBe(403);
      const list = await fixture.request({
        path: `/api/auth/organization/list-invitations?organizationId=${workspace.id}`,
        actor,
        method: 'GET',
      });
      expect(list.status).toBe(403);
      const details = await fixture.request({
        path: `/api/auth/organization/get-full-organization?organizationId=${workspace.id}`,
        actor,
        method: 'GET',
      });
      expect(details.status).toBe(200);
      expect(
        z.object({ invitations: z.array(z.unknown()) }).parse(await details.json()).invitations,
      ).toEqual([]);
    }
  });
});

describe('workspace lifecycle', () => {
  it.each(['leave', 'update-member-role'] as const)(
    'retains an owner when two owners concurrently %s',
    async (operation) => {
      await using fixture = await openWorkspaceFixture();
      const [first, second] = await Promise.all([
        fixture.createActor('first'),
        fixture.createActor('second'),
      ]);
      const workspace = await fixture.createWorkspace({ actor: first, label: 'concurrent-owners' });
      await fixture.join({
        actor: first,
        organizationId: workspace.id,
        recipient: second,
        role: 'owner',
      });
      const members = await fixture.db.query.member.findMany({
        where: eq(WORKSPACE_TABLES.member.organizationId, workspace.id),
      });
      const responses = await Promise.all([first, second].map(removeOwner));
      expect(responses.map((response) => response.status).toSorted()).toEqual([200, 400]);
      const remaining = await fixture.db.query.member.findMany({
        where: eq(WORKSPACE_TABLES.member.organizationId, workspace.id),
      });
      expect(remaining.filter((member) => member.role === 'owner')).toHaveLength(1);

      function removeOwner(actor: typeof first) {
        const member = members.find((candidate) => candidate.userId === actor.id);
        assert.ok(member);
        const body =
          operation === 'leave'
            ? { organizationId: workspace.id }
            : { organizationId: workspace.id, memberId: member.id, role: 'member' };
        return fixture.request({ path: `/api/auth/organization/${operation}`, actor, body });
      }
    },
  );

  it('protects the last owner and supports ownership handover before leaving', async () => {
    await using fixture = await openWorkspaceFixture();
    const [owner, successor] = await Promise.all([
      fixture.createActor('owner'),
      fixture.createActor('successor'),
    ]);
    const workspace = await fixture.createWorkspace({ actor: owner, label: 'handover' });
    const successorMember = await fixture.join({
      actor: owner,
      organizationId: workspace.id,
      recipient: successor,
      role: 'member',
    });
    const lastOwner = await fixture.request({
      path: '/api/auth/organization/leave',
      actor: owner,
      body: { organizationId: workspace.id },
    });
    expect(lastOwner.status).toBe(400);
    expect(ERROR_SCHEMA.parse(await lastOwner.json()).code).toBe(
      'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER',
    );
    const promote = await fixture.request({
      path: '/api/auth/organization/update-member-role',
      actor: owner,
      body: { organizationId: workspace.id, memberId: successorMember.id, role: 'owner' },
    });
    expect(promote.status).toBe(200);
    const departure = await fixture.request({
      path: '/api/auth/organization/leave',
      actor: owner,
      body: { organizationId: workspace.id },
    });
    expect(departure.status).toBe(200);
    const remaining = await fixture.request({
      path: `/api/auth/organization/list-members?organizationId=${workspace.id}`,
      actor: successor,
      method: 'GET',
    });
    expect(MEMBERS_SCHEMA.parse(await remaining.json()).members).toEqual([
      expect.objectContaining({ userId: successor.id, role: 'owner' }),
    ]);
  });

  it('deletes workspace records, invitations and memberships and clears the caller selection', async () => {
    await using fixture = await openWorkspaceFixture();
    const owner = await fixture.createActor('owner');
    const workspace = await fixture.createWorkspace({ actor: owner, label: 'deletion' });
    await fixture.invite({
      actor: owner,
      organizationId: workspace.id,
      email: 'pending@example.com',
      role: 'member',
    });
    const deleted = await fixture.request({
      path: '/api/auth/organization/delete',
      actor: owner,
      body: { organizationId: workspace.id },
    });
    expect(deleted.status).toBe(200);
    const [members, invitations, spaces, sessions] = await Promise.all([
      fixture.db
        .select()
        .from(WORKSPACE_TABLES.member)
        .where(eq(WORKSPACE_TABLES.member.organizationId, workspace.id)),
      fixture.db
        .select()
        .from(WORKSPACE_TABLES.invitation)
        .where(eq(WORKSPACE_TABLES.invitation.organizationId, workspace.id)),
      fixture.db
        .select()
        .from(WORKSPACE_TABLES.organization)
        .where(eq(WORKSPACE_TABLES.organization.id, workspace.id)),
      fixture.db
        .select()
        .from(AUTHENTICATION_TABLES.session)
        .where(eq(AUTHENTICATION_TABLES.session.userId, owner.id)),
    ]);
    expect(members).toEqual([]);
    expect(invitations).toEqual([]);
    expect(spaces).toEqual([]);
    expect(sessions.every((session) => session.activeOrganizationId === null)).toBe(true);
  });

  it('keeps organization writes behind the existing origin and trusted server boundaries', async () => {
    await using fixture = await openWorkspaceFixture();
    const owner = await fixture.createActor('owner');
    const workspace = await fixture.createWorkspace({ actor: owner, label: 'boundaries' });
    const crossOrigin = await fixture.request({
      path: '/api/auth/organization/update',
      actor: owner,
      origin: 'https://foreign.example.com',
      body: { organizationId: workspace.id, data: { name: 'Untrusted' } },
    });
    expect(crossOrigin.status).toBe(403);
    fixture.expectErrors(['Authentication: Invalid origin: https://foreign.example.com']);
    const addMember = await fixture.request({
      path: '/api/auth/organization/add-member',
      actor: owner,
      body: { organizationId: workspace.id, userId: owner.id, role: 'owner' },
    });
    expect(addMember.status).toBe(404);
    const ownList = await fixture.request({
      path: '/api/auth/organization/list',
      actor: owner,
      method: 'GET',
    });
    expect(ownList.headers.get('cache-control')).toBe('no-store');
    expect(z.array(z.object({ id: z.string() })).parse(await ownList.json())).toEqual([
      { id: workspace.id },
    ]);
  });
});
