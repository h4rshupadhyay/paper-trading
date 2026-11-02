import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/identity-input.test.ts'], testTimeout: 10000 } },
      { test: { name: 'integration', include: ['test/**/*.test.ts'], exclude: ['test/identity-input.test.ts'], testTimeout: 20000, hookTimeout: 20000, fileParallelism: false } },
    ],
  },
});
