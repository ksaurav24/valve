// Unit, property, type inference, and coverage suite configuration.
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    typecheck: { enabled: false, include: ['test/*.test-d.ts'] },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/redis/scripts.ts',
        'src/**/types.ts',
        'src/store.ts',
        'src/index.ts',
      ],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
});
