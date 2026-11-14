import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts', 'tests/sdk/**/*.pg.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
