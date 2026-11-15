import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/sdk/**/*.cloud.test.ts', 'tests/integration/**/*.cloud.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
