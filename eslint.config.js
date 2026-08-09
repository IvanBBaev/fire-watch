import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/coverage/**',
      '**/node_modules/**',
      'data/**',
      'tiles/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          // Tool configs sit outside every tsconfig on purpose — they are not shipped
          // code and must not widen the build graph — but they still get linted with
          // type information via the default project.
          allowDefaultProject: ['*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // The clock is a port (ADR-002 D7). Reading the wall clock inside the domain
          // makes lifecycle logic untestable and replays non-reproducible; adapters
          // opt out of this rule explicitly below.
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now'], NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Read time through the Clock port instead of the wall clock (server/src/core/ports/clock.ts).',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'Randomness breaks replay determinism — take a seeded generator as a parameter.',
        },
      ],
    },
  },
  {
    // Adapters are where the outside world is allowed in, and tests must be able to
    // construct instants directly.
    files: [
      '**/src/adapters/**/*.ts',
      '**/*.test.ts',
      '**/*.test.tsx',
      'packages/contracts/src/**/*.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
