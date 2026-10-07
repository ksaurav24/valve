// Real-store parity, multiprocess bounds, pause, recovery, and cluster checks.
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/integration/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
