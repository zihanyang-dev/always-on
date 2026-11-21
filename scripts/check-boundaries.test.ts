import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findBoundaryViolations } from './check-boundaries.ts';

test('allows only the contract entry points assigned to each application', () => {
  const violations = findBoundaryViolations(
    'apps/web/src/features/work.tsx',
    `
      import type { Work } from '@always-on/contracts/http';
      export type { Run } from '@always-on/contracts/execution';
      import '@always-on/contracts/http/internal';
      import '../../../server/src/work/index.js';
      export const heading = <h1>Work</h1>;
    `,
  );

  assert.deepEqual(
    violations.map(({ specifier }) => specifier),
    [
      '@always-on/contracts/execution',
      '@always-on/contracts/http/internal',
      '../../../server/src/work/index.js',
    ],
  );
});

test('enforces the direction and public entry even for type and dynamic imports', () => {
  const violations = findBoundaryViolations(
    'apps/server/src/work/routing/route-event.ts',
    `
      import { authorise } from '../../access/index.js';
      type Policy = import('../../access/policy.js').Policy;
      export type { RunResult } from '../../execution/index.js';
      import('../../entrypoints/api.js');
    `,
  );

  assert.deepEqual(
    violations.map(({ specifier }) => specifier),
    ['../../access/policy.js', '../../execution/index.js', '../../entrypoints/api.js'],
  );
});

test('lets a worker compose domains without letting infrastructure depend on them', () => {
  const source = `import { recordRunResult } from '../work/index.js';`;

  assert.deepEqual(findBoundaryViolations('apps/server/src/entrypoints/worker.ts', source), []);
  assert.equal(
    findBoundaryViolations('apps/server/src/infrastructure/dispatcher.ts', source)[0]?.reason,
    'infrastructure cannot import work.',
  );
});

test('only persistence may import database drivers, the database connection, or schema', () => {
  const source = `
    export { readSessionBinding } from './session-store.js';
    import { eq } from 'drizzle-orm';
    import type { Database } from '../../infrastructure/database/index.js';
    import { sessions } from './persistence/schema.js';
  `;
  const area = 'apps/server/src/execution/sessions';
  const violations = findBoundaryViolations(`${area}/prepare-resume.ts`, source);

  assert.deepEqual(
    violations.map(({ specifier }) => specifier),
    ['drizzle-orm', '../../infrastructure/database/index.js', './persistence/schema.js'],
  );
  assert.deepEqual(findBoundaryViolations(`${area}/session-store.ts`, source), []);
  assert.deepEqual(findBoundaryViolations(`${area}/session-store.test.ts`, source), []);
});

test('restricts CommonJS database imports and permits migration access to schema', () => {
  assert.equal(
    findBoundaryViolations('apps/cloud-runner/src/main.cjs', `require('pg');`)[0]?.specifier,
    'pg',
  );
  assert.deepEqual(
    findBoundaryViolations(
      'apps/server/migrations/schema.ts',
      `export { sessions } from '../src/execution/sessions/persistence/schema.js';`,
    ),
    [],
  );
});

test('startup may open the pool through the database index', () => {
  const database = `import { openDatabase } from '../infrastructure/database/index.ts';`;
  assert.deepEqual(findBoundaryViolations('apps/server/src/entrypoints/api.ts', database), []);
  assert.equal(findBoundaryViolations('apps/server/src/access/index.ts', database).length, 1);

  const generated = `import type { DB } from '../infrastructure/database/database.types.ts';`;
  assert.equal(findBoundaryViolations('apps/server/src/entrypoints/api.ts', generated).length, 1);
});

test('routes use the public HTTP entry and HTTP stays independent of domains', () => {
  const route = 'apps/server/src/access/workspaces/workspace-routes.ts';
  assert.deepEqual(
    findBoundaryViolations(route, `import { errorResponse } from '../../http/index.ts';`),
    [],
  );
  assert.equal(
    findBoundaryViolations('apps/server/src/http/index.ts', `import '../access/index.ts';`).length,
    1,
  );
});

test('a channel can publish through Work without exposing its store to adapters', () => {
  const webhook = 'apps/server/src/channels/webhook/webhook-routes.ts';
  const work = 'apps/server/src/work/inbox/inbox-store.ts';
  assert.deepEqual(
    findBoundaryViolations(
      webhook,
      `import type { Inbox } from '../../work/index.ts'; import { Webhook } from 'standardwebhooks';`,
    ),
    [],
  );
  assert.equal(
    findBoundaryViolations(
      webhook,
      `import { createInbox } from '../../work/inbox/inbox-store.ts';`,
    ).length,
    1,
  );
  assert.equal(
    findBoundaryViolations(work, `import '../../channels/index.ts'; import 'standardwebhooks';`)
      .length,
    2,
  );
});

test('Access routes use their stores and the public authentication entry', () => {
  const route = 'apps/server/src/access/workspaces/workspace-routes.ts';
  const imports = `
    import type { WorkspaceStore } from './workspace-store.ts';
    import type { SignedInUser } from '../authentication/index.ts';
    import { authDatabase } from '../authentication/persistence/auth-database.ts';
    import { lockWorkspace } from './persistence/workspace-authorization.ts';
    import { betterAuth } from 'better-auth';
  `;
  assert.deepEqual(
    findBoundaryViolations(route, imports).map(({ specifier }) => specifier),
    [
      '../authentication/persistence/auth-database.ts',
      './persistence/workspace-authorization.ts',
      'better-auth',
    ],
  );
  assert.deepEqual(
    findBoundaryViolations(
      'apps/server/src/access/authentication/index.ts',
      `
    import { betterAuth } from 'better-auth';
    import { authDatabase } from './persistence/auth-database.ts';
  `,
    ),
    [],
  );
  assert.equal(
    findBoundaryViolations(
      'apps/server/src/access/authentication/index.ts',
      `
    import { createWorkspaceAccessRoutes } from '../workspaces/index.ts';
  `,
    ).length,
    1,
  );
});
