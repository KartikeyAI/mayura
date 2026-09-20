import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Bound concurrent native/SQL/packed-consumer fixtures on developer machines and CI.
    maxWorkers: 4,
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
