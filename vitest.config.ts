import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const contractsSrc = (file: string): string =>
  fileURLToPath(new URL(`./packages/contracts/src/${file}`, import.meta.url));

// Tests run against the workspace sources, not against a stale `dist`. Without this a
// green test run could be describing the previous build.
const resolve = {
  alias: [
    { find: /^@fire-watch\/contracts\/node$/, replacement: contractsSrc('node.ts') },
    { find: /^@fire-watch\/contracts$/, replacement: contractsSrc('index.ts') },
  ],
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          include: ['{packages/*,server,web}/src/**/*.test.{ts,tsx}'],
          // Integration tests are the same kind of file in the same tree, so they are
          // excluded by name rather than by directory — that keeps them inside the
          // build tsconfig and so under typecheck like everything else.
          exclude: ['**/*.integration.test.ts'],
          environment: 'node',
          // A test that needs more than this is waiting on something it should have faked.
          testTimeout: 10_000,
        },
      },
      {
        resolve,
        test: {
          name: 'integration',
          include: ['{packages/*,server,web}/src/**/*.integration.test.ts'],
          environment: 'node',
          // Pulling and starting postgis/postgis:16-3.4 on a cold cache dominates this;
          // the assertions themselves are milliseconds.
          testTimeout: 180_000,
          hookTimeout: 300_000,
          // One container at a time: these suites are cheap to run and expensive to
          // start, and parallel Docker pulls on a small CI runner are how they flake.
          fileParallelism: false,
        },
      },
    ],
  },
});
