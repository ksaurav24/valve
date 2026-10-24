// Dual ESM and CommonJS package entry points.
import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/headers/index.ts',
    'src/redis/index.ts',
    'src/group/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  platform: 'neutral',
  target: 'es2022',
  exports: false,
});
