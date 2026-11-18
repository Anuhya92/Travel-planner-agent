import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'www/**', 'android/**', 'ios/**', 'commute.json'],
  },
  js.configs.recommended,
  {
    files: ['server.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: globals.node,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    files: ['app.js', 'sw.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker },
      ecmaVersion: 'latest',
      sourceType: 'script',
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-constant-condition': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
];
