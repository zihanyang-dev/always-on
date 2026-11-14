import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/sdk/**/*.test.ts'] },
});
