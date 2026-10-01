module.exports = {
  root: true,
  env: {
    es2022: true,
    jest: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended'],
  ignorePatterns: ['coverage/', 'dist/', 'src/generated/api.ts'],
  rules: {
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-debugger': 'error',
    'no-redeclare': 'off',
    'no-throw-literal': 'error',
    'no-undef': 'off',
    'no-unused-vars': 'off',
    'no-unsafe-finally': 'error',
  },
};
