// Real Redis/Valkey parity and harness runs. Requires a disposable endpoint (see README).
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 180000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
