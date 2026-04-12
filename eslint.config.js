import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import js from '@eslint/js';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      eslintConfigPrettier
    ],
    files: ['**/*.ts'],
    ignores: ['**/*.d.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-duplicate-imports': 'error',
      'no-self-compare': 'error',
      'no-unreachable-loop': 'error',
      'no-template-curly-in-string': 'error',
      'default-case': ['error', { commentPattern: '^skip\\sdefault' }],
      'default-case-last': 'error'
    }
  }
);
