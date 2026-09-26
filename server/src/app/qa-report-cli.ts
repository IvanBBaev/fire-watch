#!/usr/bin/env node
/**
 * The weekly QA report by hand (TASKS D8): build one week's (or one range's) report,
 * write it as JSON and Markdown, and store it when it is a closed ISO week.
 *
 *   node server/dist/app/qa-report-cli.js --out=reports            # last closed week
 *   node server/dist/app/qa-report-cli.js --week=2026-W38 --out=reports
 *   node server/dist/app/qa-report-cli.js --from=2026-09-01 --to=2026-09-10 --out=reports
 *
 * Writes `<out>/<stem>.json` (canonical JSON plus a newline) and `<out>/<stem>.md`, where
 * the stem is `qa-weekly-YYYY-Www` or `qa-range-FROM_TO`. The job is the worker loop's
 * (`qa-report-wiring.ts`), minus the skip: an explicit request always rebuilds. A closed
 * ISO week is also upserted into `qa_weekly_reports`; a re-run over the same rows and
 * configs replaces the row, and a changed digest under the same version is refused.
 *
 * Exit codes: 0 — written; 1 — the run failed on data or I/O; 2 — misconfiguration. The
 * starting line goes to stderr; stdout gets one canonical-JSON summary line.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createPgQaReportStore } from '../adapters/db/pg-qa-report-store.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { QA_METRICS } from '../core/qa/qa-metrics-params.js';
import { runWeeklyQaReport, summarizeOutcome } from '../core/qa/weekly-report-job.js';
import { QA_WEEKLY_REPORT } from '../core/qa/weekly-report-params.js';
import { ConfigError } from './config.js';
import { processLog } from './logging.js';
import {
  describeQaReportConfig,
  loadQaReportConfig,
  parseQaReportArgs,
  reportFileStem,
  resolveReportWindow,
} from './qa-report-config.js';

const EXIT_MISCONFIGURED = 2;

const log = processLog();

async function main(): Promise<number> {
  const args = parseQaReportArgs(process.argv.slice(2));
  const config = loadQaReportConfig(process.env);
  const window = resolveReportWindow(args.window, systemClock.now());
  const stem = reportFileStem(args.window, window);

  log.note({
    starting: {
      ...describeQaReportConfig(config),
      window: args.window.kind,
      iso_week: window.isoWeek,
      out: join(args.outDir, stem),
      metrics_config: QA_METRICS.version,
      metrics_config_digest: QA_METRICS.digest,
      report_config: QA_WEEKLY_REPORT.version,
      report_config_digest: QA_WEEKLY_REPORT.digest,
    },
  });

  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: 'fire-watch-qa-report',
  });

  try {
    const store = createPgQaReportStore(pool);
    const outcome = await runWeeklyQaReport(
      { reader: store, store, clock: systemClock, pollIntervalMs: config.pollIntervalMs },
      { window },
    );
    if (outcome.outcome !== 'built') throw new Error('an explicit window is never skipped');
    await mkdir(args.outDir, { recursive: true });
    await writeFile(join(args.outDir, `${stem}.json`), `${outcome.json}\n`, 'utf8');
    await writeFile(join(args.outDir, `${stem}.md`), outcome.markdown, 'utf8');
    log.line(canonicalJson({ qa_weekly_report: summarizeOutcome(outcome) }));
    return 0;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
