import { defineConfig } from 'vitest/config';

// Hosted Windows CI runners are often several times slower than a developer machine (fixtures that take 0.3 s locally
// have exceeded 10 s there), so timeouts scale up on them only. Local runs and the other platforms keep the tight
// defaults that catch real hangs.
const slowRunner = process.env['CI'] === 'true' && process.platform === 'win32';

export default defineConfig({
  test: {
    // Keep fsync-heavy retention, process-kill and short-lease fixtures from
    // competing with too many independent suites. In-test worker races are unchanged.
    maxWorkers: 2,
    testTimeout: slowRunner ? 30_000 : 10_000,
    hookTimeout: slowRunner ? 45_000 : 15_000,
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
          testTimeout: slowRunner ? 90_000 : 30_000,
        },
      },
    ],
  },
});
