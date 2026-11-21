import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import {
  type AccessClient,
  expectStatus,
  objectField,
  responseBody,
  textField,
  withAccessFixture,
} from './access-fixture.ts';

const TIMESTAMP = '2026-01-01T00:00:00.123Z';

test('Workspace access against PostgreSQL', async (suite) => {
  await withAccessFixture(
    async ({ db, request, register, receivedLink, observer, databaseName, databaseUrl }) => {
      await suite.test(
        'uses JSON errors for malformed and oversized application requests',
        async () => {
          const { cookie } = await register({ email: 'transport@example.test', ip: 6 });
          const path = '/api/workspaces';

          for (const body of ['{', { name: 42 }, { name: 'bad\u0000name' }]) {
            const invalid = await request(path, { method: 'POST', cookie, body });
            await expectStatus(invalid, 400);
            assert.deepEqual(await invalid.json(), { error: 'invalid_input' });
          }

          const large = await request(path, {
            method: 'POST',
            cookie,
            body: { name: 'x'.repeat(16_384) },
          });
          await expectStatus(large, 413);
          assert.deepEqual(await large.json(), { error: 'request_too_large' });

          const cursor = Buffer.from(
            JSON.stringify({
              time: '0000-01-01T00:00:00.000Z',
              id: randomUUID(),
            }),
          ).toString('base64url');
          const invalidCursor = await request(`${path}?cursor=${cursor}`, { cookie });
          await expectStatus(invalidCursor, 400);
          assert.deepEqual(await invalidCursor.json(), { error: 'invalid_input' });
        },
      );

      await suite.test(
        'Workspace permissions, invitation ownership, and cursor pagination',
        async () => {
          const [owner, member, outsider] = await Promise.all([
            register({ email: 'owner@example.test', ip: 3 }),
            register({ email: 'member@example.test', ip: 4 }),
            register({ email: 'outsider@example.test', ip: 5 }),
          ]);

          const create = async (name: string) => {
            const response = await request('/api/workspaces', {
              method: 'POST',
              cookie: owner.cookie,
              body: { name, userId: outsider.userId },
            });
            await expectStatus(response, 201);
            const workspace = objectField((await responseBody(response)).workspace);
            assert.equal(workspace.role, 'owner');
            return textField(workspace.id);
          };

          const workspaceId = await create('One');
          const secondId = await create('Two');
          const path = `/api/workspaces/${workspaceId}`;
          await db.updateTable('workspaces').set({ created_at: TIMESTAMP }).execute();

          await expectStatus(await request(path, { cookie: outsider.cookie }), 404);
          await expectStatus(
            await request(path, {
              method: 'PATCH',
              cookie: owner.cookie,
              origin: 'https://example.test',
              body: { name: 'New' },
            }),
            403,
          );
          await expectStatus(
            await request(`${path}/membership`, { method: 'DELETE', cookie: owner.cookie }),
            409,
          );

          const listed = await readTwoPages(request, {
            path: '/api/workspaces',
            collection: 'workspaces',
            cookie: owner.cookie,
          });
          assert.deepEqual(listed.map(({ id }) => id).sort(), [workspaceId, secondId].sort());
          await expectStatus(
            await request('/api/workspaces?limit=101', { cookie: owner.cookie }),
            400,
          );
          await expectStatus(
            await request('/api/workspaces?cursor=bad', { cookie: owner.cookie }),
            400,
          );

          const issue = async (email: string) => {
            const response = await request(`${path}/invitations`, {
              method: 'POST',
              cookie: owner.cookie,
              body: { email, role: 'member' },
            });
            await expectStatus(response, 201);
            const body = await responseBody(response);
            assert.equal(body.delivery, 'sent');
            const invitation = objectField(body.invitation);
            assert.equal('token' in invitation, false);
            return textField(invitation.id);
          };

          const cancelled = await issue('cancel@example.test');
          const accepted = await issue('member@example.test');
          const invitations = await readTwoPages(request, {
            path: `${path}/invitations`,
            collection: 'invitations',
            cookie: owner.cookie,
          });
          assert.deepEqual(invitations.map(({ id }) => id).sort(), [cancelled, accepted].sort());

          const cancel = { method: 'DELETE', cookie: owner.cookie };
          await expectStatus(
            await request(`/api/workspaces/${secondId}/invitations/${cancelled}`, cancel),
            404,
          );
          await expectStatus(await request(`${path}/invitations/${cancelled}`, cancel), 204);
          await expectStatus(await request(`${path}/invitations/${cancelled}`, cancel), 404);

          const link = receivedLink('member@example.test');
          await expectStatus(
            await request(link.pathname + link.search, { cookie: outsider.cookie }),
            404,
          );
          await expectStatus(
            await request(link.pathname + link.search, { cookie: member.cookie }),
            200,
          );

          const accept = () =>
            request('/api/workspaces/invitations/accept', {
              method: 'POST',
              cookie: member.cookie,
              body: { token: link.searchParams.get('token') },
            });
          const attempts = await Promise.all([accept(), accept()]);
          assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 409]);

          await db.updateTable('workspace_members').set({ joined_at: TIMESTAMP }).execute();
          const members = await readTwoPages(request, {
            path: `${path}/members`,
            collection: 'members',
            cookie: owner.cookie,
          });
          assert.deepEqual(
            members.map(({ userId }) => userId).sort(),
            [owner.userId, member.userId].sort(),
          );
          await expectStatus(
            await request(path, {
              method: 'PATCH',
              cookie: member.cookie,
              body: { name: 'New' },
            }),
            403,
          );

          const rolePath = `${path}/members/${member.userId}`;
          await expectStatus(
            await request(rolePath, {
              method: 'PATCH',
              cookie: owner.cookie,
              body: { role: 'admin' },
            }),
            204,
          );
          await expectStatus(
            await request(path, {
              method: 'PATCH',
              cookie: member.cookie,
              body: { name: 'Renamed' },
            }),
            200,
          );
          await expectStatus(
            await request(`${path}/members/${owner.userId}`, {
              method: 'DELETE',
              cookie: member.cookie,
            }),
            403,
          );

          const expired = await issue('outsider@example.test');
          const expiredToken = receivedLink('outsider@example.test').searchParams.get('token');
          await db
            .updateTable('workspace_invitations')
            .set({ expires_at: TIMESTAMP })
            .where('id', '=', expired)
            .execute();
          const acceptAsOutsider = (token: string | null) =>
            request('/api/workspaces/invitations/accept', {
              method: 'POST',
              cookie: outsider.cookie,
              body: { token },
            });
          const expiredResponse = await acceptAsOutsider(expiredToken);
          await expectStatus(expiredResponse, 409);
          assert.deepEqual(await expiredResponse.json(), { error: 'invitation_used' });
          assert.notEqual(await issue('outsider@example.test'), expired);
          await expectStatus(await acceptAsOutsider(expiredToken), 409);
          await expectStatus(
            await acceptAsOutsider(receivedLink('outsider@example.test').searchParams.get('token')),
            200,
          );

          const target = `${path}/members/${outsider.userId}`;
          await expectStatus(
            await request(target, {
              method: 'PATCH',
              cookie: member.cookie,
              body: { role: 'admin' },
            }),
            403,
          );
          await expectStatus(
            await request(target, {
              method: 'PATCH',
              cookie: member.cookie,
              body: { role: 'viewer' },
            }),
            204,
          );
          await expectStatus(
            await request(target, { method: 'DELETE', cookie: member.cookie }),
            204,
          );
          await expectStatus(await request(path, { cookie: outsider.cookie }), 404);

          await checkQueuedRename({
            observer,
            databaseName,
            databaseUrl,
            request,
            workspaceId,
            member,
          });

          await expectStatus(
            await request(rolePath, {
              method: 'PATCH',
              cookie: owner.cookie,
              body: { role: 'owner' },
            }),
            204,
          );
          const cookies = [owner.cookie, member.cookie];
          const leaves = await Promise.all(
            cookies.map((cookie) => request(`${path}/membership`, { method: 'DELETE', cookie })),
          );
          assert.deepEqual(leaves.map(({ status }) => status).sort(), [204, 409]);
          for (const [index, cookie] of cookies.entries()) {
            await expectStatus(
              await request(path, { cookie }),
              leaves[index]?.status === 204 ? 404 : 200,
            );
          }
        },
      );
    },
    { defaultIsolation: 'repeatable read' },
  );
});

async function checkQueuedRename({
  observer,
  databaseName,
  databaseUrl,
  request,
  workspaceId,
  member,
}: {
  observer: pg.Client;
  databaseName: string;
  databaseUrl: string;
  request: AccessClient;
  workspaceId: string;
  member: { userId: string; cookie: string };
}) {
  const lock = new pg.Client({ connectionString: databaseUrl });
  await lock.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM always_on.workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);

    const [response, revocation] = await Promise.allSettled([
      request(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        cookie: member.cookie,
        body: { name: 'Stale authorization' },
      }),
      revokeAfterRenameWaits(),
    ]);
    if (revocation.status === 'rejected') throw revocation.reason;
    if (response.status === 'rejected') throw response.reason;
    await expectStatus(response.value, 403);
    const saved = await request(`/api/workspaces/${workspaceId}`, { cookie: member.cookie });
    await expectStatus(saved, 200);
    assert.equal(objectField((await responseBody(saved)).workspace).name, 'Renamed');
  } finally {
    await lock.end();
  }

  async function revokeAfterRenameWaits() {
    try {
      await waitForWorkspaceLock({ observer, databaseName });
      await lock.query(
        "UPDATE always_on.workspace_members SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, member.userId],
      );
      await lock.query('COMMIT');
    } catch (error) {
      await lock.query('ROLLBACK');
      throw error;
    }
  }
}

async function waitForWorkspaceLock({
  observer,
  databaseName,
}: {
  observer: pg.Client;
  databaseName: string;
}) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = $1 AND wait_event_type = 'Lock' AND query LIKE '%"workspaces"%for update%'
      ) AS waiting`,
      [databaseName],
    );
    if (result.rows[0]?.waiting) return;
    await delay(10);
  }
  throw new Error('The rename did not reach the Workspace lock');
}

async function readTwoPages(
  request: AccessClient,
  {
    path,
    collection,
    cookie,
  }: {
    path: string;
    collection: 'workspaces' | 'members' | 'invitations';
    cookie: string;
  },
) {
  const first = await request(`${path}?limit=1`, { cookie });
  await expectStatus(first, 200);
  const firstPage = await responseBody(first);
  const rows = firstPage[collection];
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);

  const cursor = textField(firstPage.nextCursor);
  const second = await request(`${path}?limit=1&cursor=${cursor}`, { cookie });
  await expectStatus(second, 200);
  const lastPage = await responseBody(second);
  const remaining = lastPage[collection];
  assert.ok(Array.isArray(remaining));
  assert.equal(remaining.length, 1);
  assert.equal(lastPage.nextCursor, null);

  return [objectField(rows[0]), objectField(remaining[0])];
}
