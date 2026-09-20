import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep fsync-heavy retention, process-kill and short-lease fixtures from
    // competing with too many independent suites. In-test worker races are unchanged.
    maxWorkers: 2,
    testTimeout: 10_000,
    hookTimeout: 15_000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.integration.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
