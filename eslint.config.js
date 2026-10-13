'use strict'
// Lint is a development tool only; the plugin itself has no runtime dependencies.
const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', 'bin/bulkhead*'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // Hooks deliberately swallow errors to fail open: `catch {}` is the house style.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
      // The guards are built from regular expressions; a control character in one is intentional.
      'no-control-regex': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      strict: ['error', 'global'],
      'no-shadow': 'warn',
      'no-throw-literal': 'error',
      'no-return-await': 'error',
      'no-useless-escape': 'warn',
      'no-misleading-character-class': 'error',
      'require-unicode-regexp': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
]
