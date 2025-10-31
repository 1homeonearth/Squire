const nodeGlobals = Object.fromEntries(
  Object.getOwnPropertyNames(globalThis).map((name) => [name, 'readonly'])
);

export default [
  {
    ignores: ['node_modules/', 'coverage/', 'dist/', 'squirectl']
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 'latest',
      globals: nodeGlobals
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'eqeqeq': 'error',
      'no-undef': 'error'
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 'latest',
      globals: {
        ...nodeGlobals,
        vi: true,
        describe: true,
        it: true,
        test: true,
        expect: true
      }
    }
  }
];
