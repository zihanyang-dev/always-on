import { expect, it } from 'vitest';
import { READINESS_SCHEMA } from './system.js';

it.each([
  { status: 'ready', checks: { database: 'down', redis: 'up' } },
  { status: 'unavailable', checks: { database: 'up', redis: 'up' } },
])('rejects inconsistent readiness snapshots %j', (snapshot) => {
  expect(READINESS_SCHEMA.safeParse(snapshot).success).toBe(false);
});
