import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vitest/config';

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

// The PostGIS image every Testcontainers suite starts. Each suite pins it as a literal
// (`postgis/postgis:16-3.4`, the same tag CI's `integration` job runs), and this is the
// one place that swaps it: `postgis/postgis` publishes amd64 only, so on Apple Silicon
// it runs under emulation and misses the container health check. `FIRE_WATCH_PG_IMAGE`
// names a build of the same PostgreSQL/PostGIS versions for the host's architecture
// (e.g. `imresamu/postgis:16-3.4`). Unset, nothing is rewritten and CI is unchanged.
const PINNED_POSTGIS_IMAGE = /'postgis\/postgis:[^']+'/g;

function postgisImageOverride(image: string | undefined): Plugin {
  const override = image?.trim();
  return {
    name: 'fire-watch:postgis-image-override',
    enforce: 'pre',
    transform(code, id) {
      if (!override || !id.endsWith('.integration.test.ts')) return null;
      const rewritten = code.replace(PINNED_POSTGIS_IMAGE, JSON.stringify(override));
      return rewritten === code ? null : { code: rewritten, map: null };
    },
  };
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          include: [
            '{packages/*,server,web}/src/**/*.test.{ts,tsx}',
            // CI-12's classifier, on synthetic manifests: no build needed, so it runs here.
            'web/budgets/**/*.test.ts',
            // J4: the L-12 deploy gate is a pure function over CI-supplied inputs.
            'infra/deploy-gate/**/*.test.ts',
            // G1/G2: the tile and glyph build planning core, on tiny in-test fixtures.
            'infra/tiles/**/*.test.ts',
            // K2: the L-3 load-test model, report, and a tiny in-process smoke run.
            'loadtest/src/**/*.test.ts',
            // J5: the status-page model/renderer, the email-auth evaluator and the
            // defensive-domain generator — pure, no network.
            'infra/status/**/*.test.ts',
            // CI-12's timing half: the gate's statistics, its budget data against
            // puppeteer's presets, and the stand-in tile encoder — no browser.
            'web/e2e/timing/**/*.test.ts',
          ],
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
        plugins: [postgisImageOverride(process.env['FIRE_WATCH_PG_IMAGE'])],
        test: {
          name: 'integration',
          include: ['{packages/*,server,web}/src/**/*.integration.test.ts'],
          environment: 'node',
          // Pulling and starting the PostGIS image on a cold cache dominates this;
          // the assertions themselves are milliseconds.
          testTimeout: 180_000,
          hookTimeout: 300_000,
          // One container at a time: these suites are cheap to run and expensive to
          // start, and parallel Docker pulls on a small CI runner are how they flake.
          fileParallelism: false,
        },
      },
      {
        resolve,
        test: {
          // CI-12: byte budgets over the real `web/dist`. Needs a build, so it is not part
          // of `verify`; `pnpm run test:budgets` builds first.
          name: 'budgets',
          include: ['web/budgets/**/*.budget.ts'],
          environment: 'node',
        },
      },
      {
        resolve,
        test: {
          name: 'e2e',
          include: ['web/e2e/**/*.e2e.ts'],
          environment: 'node',
          // Real browser, real HTTP, real timers: a scenario waits for polls on the
          // client's own cadence, so its budget is minutes, not milliseconds.
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // One browser at a time; the scenarios share nothing but are not cheap.
          fileParallelism: false,
        },
      },
      {
        resolve,
        test: {
          // CI-12's timing half: map-ready under throttled network and CPU, median of N
          // cold runs per profile (`web/e2e/timing/map-ready-budget.ts`). Needs a build and
          // a browser, so it is not part of `verify`; `pnpm run test:timing` builds first.
          name: 'timing',
          include: ['web/e2e/**/*.timing.ts'],
          environment: 'node',
          // Up to `maxAttempts` runs per profile at up to four times a 15 s budget each.
          testTimeout: 30 * 60_000,
          hookTimeout: 120_000,
          // A timing gate measures nothing useful while another browser shares the CPU.
          fileParallelism: false,
        },
      },
    ],
  },
});
