import { expect, it } from 'vitest';
import { findBoundaryViolations } from './check-boundaries.mjs';

it('allows a public feature entry and rejects direct imports of its internals', () => {
  const source = `
    import { readWorkspaceRoles } from '../workspaces/index.js';
    export type { WorkspaceRole } from '../workspaces/permissions.js';
    type PrivateAgent = typeof import('../agents/store.js');
  `;
  const violations = findBoundaryViolations('apps/server/src/sessions/review.ts', source);
  expect(violations.map(({ source: target }) => target)).toEqual([
    '../workspaces/permissions.js',
    '../agents/store.js',
  ]);
});

it('rejects SDK imports outside their owner and cross-workspace relative imports', () => {
  const source = `
    import type { Agent } from '@always-on/contracts/agents';
    const runtime = import('@always-on/agent-runtime/pi');
    export { executeCloudRun } from '../../server/src/bootstrap/cloud-agent.js';
    import { Sandbox } from 'e2b';
  `;
  const violations = findBoundaryViolations('apps/web/src/review.ts', source);
  expect(violations.map(({ source: target }) => target)).toEqual([
    '@always-on/agent-runtime/pi',
    '../../server/src/bootstrap/cloud-agent.js',
    'e2b',
  ]);
});

it('keeps shared middleware and infrastructure independent of product features', () => {
  const source = "import { createSessionRoutes } from '../../sessions/index.js';";
  const violations = findBoundaryViolations(
    'apps/server/src/infrastructure/database/review.ts',
    source,
  );
  expect(violations).toHaveLength(1);
  expect(violations[0]?.reason).toContain('cannot depend on product features');
});
