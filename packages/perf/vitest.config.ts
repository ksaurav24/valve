// Unit, model, oracle, statistics, and golden tests. No external services.
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // Real-timer adapter assertions must not compete with the cold-process probes.
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    testTimeout: 30000,
  },
});
