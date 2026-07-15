// Flat ESLint config for the whole monorepo.
// Intentionally NOT type-aware (no parserOptions.project): keeps lint fast and
// decoupled from any single tsconfig, and avoids TS-version coupling. Type safety
// is enforced separately by `pnpm typecheck` (tsc) per package.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.expo/**',
      '**/web-build/**',
      '**/.data/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/babel.config.js',
      '**/metro.config.js',
      '**/expo-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  prettier,
);
