import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'node_modules/**',
      'pvt/**',
      '**/.next/**',
      '**/.source/**',
      '**/out/**',
      'docs/next-env.d.ts',
      'docs/public/api/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/valve/src/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['node:*'] }] },
  },
  {
    files: ['scripts/smoke.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  { languageOptions: { globals: globals.node } },
);
