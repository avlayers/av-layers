import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.wrangler/**', '**/output/**', '**/.cache/**', '**/.tools/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/apps/**', '**/scripts/**'] }]
    }
  },
  {
    files: ['packages/{client,windgram}/src/**/*.{ts,tsx}', 'apps/preview/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['@av/contracts', '@av/contracts/models', '@av/forecast', '@av/forecast/frame', '@av/forecast/refinement'],
        patterns: ['**/apps/batch/**', '**/apps/api/**', '**/models.json']
      }]
    }
  }
);
