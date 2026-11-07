/**
 * Where the client reads events from, and which deploys may say so (FD-5).
 *
 * Dependency-free on purpose: `web/vite.config.ts` imports it to refuse a production build
 * that would ship the committed fixtures, so it cannot pull in anything a config file
 * cannot load.
 */

/**
 * `fixtures` (the default, and what tests, e2e and CI-7 run against) or `live`, the API's
 * `/snapshot.json` (`pnpm dev:live`).
 */
export type DataSource = 'fixtures' | 'live';

/**
 * The build's data source from a raw env value (`VITE_FIRE_WATCH_DATA`). Anything but an
 * explicit `live` is the fixtures, so a typo can never point CI at a server.
 */
export function readDataSource(raw: string | undefined): DataSource {
  return raw?.trim().toLowerCase() === 'live' ? 'live' : 'fixtures';
}

/**
 * Why a build for `deployEnv` must not ship with `source`, or `null` when it may.
 *
 * Data policy, "Fixtures out of prod" (docs/decisions/founder-2026-10-30/data-policy.md): a
 * production public deploy never serves fixtures as live data, so `production` with
 * anything but `live` is refused. Every other environment may serve fixtures, and the shell
 * then shows the permanent demo-data notice. `deployEnv` is the raw `FIRE_WATCH_DEPLOY_ENV`;
 * unset is a local or CI build.
 */
export function deployDataProblem(
  deployEnv: string | undefined,
  source: DataSource,
): string | null {
  if (deployEnv?.trim().toLowerCase() !== 'production' || source === 'live') return null;
  return (
    'FIRE_WATCH_DEPLOY_ENV=production would build the client on fixture data, and a ' +
    'production deploy never serves fixtures as live data (data policy, FD-5). ' +
    'Build with VITE_FIRE_WATCH_DATA=live.'
  );
}
