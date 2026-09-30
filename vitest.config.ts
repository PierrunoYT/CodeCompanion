import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    projects: [
      {
        extends: true,
        // Generous timeouts: the first PowerShell start on a cold CI runner can take several seconds.
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        // Measurements, not pass/fail tests: `npm run perf`. Not part of `npm test`.
        extends: true,
        test: {
          name: 'perf',
          include: ['tests/perf/**/*.perf.ts'],
          testTimeout: 180_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
