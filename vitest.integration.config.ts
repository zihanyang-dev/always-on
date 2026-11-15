import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts', 'tests/sdk/**/*.pg.test.ts'],
    exclude: ['tests/integration/**/*.cloud.test.ts'],
    // Workers dispatch all queued Runs in this database; fixtures must not consume each other's work.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
