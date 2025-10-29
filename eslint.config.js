import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'coverage/', 'dist/', 'squirectl']
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 'latest',
      globals: {
        ...globals.node
      }
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
        ...globals.node,
        vi: true,
        describe: true,
        it: true,
        test: true,
        expect: true
      }
    }
  }
];
