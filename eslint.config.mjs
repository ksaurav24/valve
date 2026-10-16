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
      '.codegraph/**',
      '.agents/**',
      '.taste-skill/**',
      '**/.next/**',
      '**/.source/**',
      '**/out/**',
      'apps/web/next-env.d.ts',
      'apps/web/public/api/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/valve/src/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['node:*'] }] },
  },
  {
    // shadcn registry components drop props by destructuring them away.
    files: ['apps/web/components/ui/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['scripts/smoke.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  { languageOptions: { globals: globals.node } },
);
