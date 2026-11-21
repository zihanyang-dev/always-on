import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'scripts/**/*.test.mjs',
      'tests/sdk/**/*.test.ts',
    ],
    exclude: [
      ...configDefaults.exclude,
      'tests/sdk/**/*.pg.test.ts',
      'tests/sdk/**/*.sandbox.test.ts',
      'tests/sdk/**/*.cloud.test.ts',
    ],
  },
});
