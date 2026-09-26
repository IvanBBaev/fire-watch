#!/usr/bin/env node
/**
 * NRT-lag histograms by hand (TASKS C9; A23): record days, or export the profile D5's
 * `availability.json` fixture input is built from.
 *
 *   node server/dist/app/lag-histogram-cli.js record
 *   node server/dist/app/lag-histogram-cli.js record --day=2026-10-01 --day=2026-10-02
 *   node server/dist/app/lag-histogram-cli.js export --from=2026-10-01 --to=2026-10-07 \
 *     > availability.json
 *
 * `record` runs the same recorder as the worker loop (`lag-histogram-wiring.ts`) and
 * prints its report; recomputing a day is idempotent, so re-running is safe. `export`
 * reads persisted rows only — record first — and prints the canonical profile as one line
 * on stdout, identical on a re-run over the same rows.
 *
 * Exit codes: 0 — done; 1 — the run failed on data; 2 — misconfiguration. The starting
 * line goes to stderr so piped output stays machine-readable.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgLagHistogramStore } from '../adapters/db/pg-lag-histogram-store.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { availabilityProfile, renderAvailabilityProfile } from '../core/ingest/lag-histogram.js';
import { NRT_LAG_HISTOGRAM } from '../core/ingest/lag-histogram-params.js';
import { recordLagHistograms } from '../core/ingest/lag-recorder.js';
import { ConfigError } from './config.js';
import {
  describeLagHistogramConfig,
  loadLagHistogramConfig,
  parseLagHistogramArgs,
} from './lag-histogram-config.js';
import { processLog } from './logging.js';

const EXIT_MISCONFIGURED = 2;

const log = processLog();

async function main(): Promise<number> {
  const command = parseLagHistogramArgs(process.argv.slice(2));
  const config = loadLagHistogramConfig(process.env);

  log.note({
    starting: {
      ...describeLagHistogramConfig(config),
      command: command.kind,
      histogram_config: NRT_LAG_HISTOGRAM.version,
      histogram_config_digest: NRT_LAG_HISTOGRAM.digest,
    },
  });

  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: 'fire-watch-lag-histograms',
  });

  try {
    const store = createPgLagHistogramStore(pool);
    if (command.kind === 'record') {
      const report = await recordLagHistograms(
        { reader: store, store, clock: systemClock, config: NRT_LAG_HISTOGRAM },
        command.days === null ? {} : { days: command.days },
      );
      log.line(canonicalJson({ lag_histograms: report }));
      return 0;
    }

    const window = { fromDay: command.fromDay, toDay: command.toDay };
    const daily = await store.loadDaily({
      ...window,
      histogramVersion: NRT_LAG_HISTOGRAM.version,
    });
    log.line(
      renderAvailabilityProfile(
        availabilityProfile({ histogramVersion: NRT_LAG_HISTOGRAM.version, window, daily }),
      ),
    );
    return 0;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
