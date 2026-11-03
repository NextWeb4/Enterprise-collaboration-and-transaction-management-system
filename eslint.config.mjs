// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.data/**',
      'data/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // 架构约束：业务模块不得直接导入 lmdb（AGENTS.md §4.1）
    files: ['app/backend/src/**/*.ts'],
    ignores: ['app/backend/src/storage/engine.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['lmdb', 'lmdb/*'],
              message: 'LMDB 只能在 app/backend/src/storage/engine.ts 中使用（AGENTS.md §4.1）',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['app/frontend/src/**/*.tsx', 'app/frontend/src/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['app/backend/src/cli/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
