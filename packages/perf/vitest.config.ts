// Unit, model, oracle, statistics, and golden tests. No external services.
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    testTimeout: 30000,
  },
});
