#!/usr/bin/env node
/**
 * The D7 month promotion — NRT out, SP in (ADR-002 D7 as amended by A1.4; TASKS C7).
 *
 *   node server/dist/app/sp-promotion-cli.js --month=2020-07 --dry-run
 *   node server/dist/app/sp-promotion-cli.js --month=2020-07 --confirm
 *
 * Stages the month's SP rows from the B8 archive into a staging table beside the live
 * partition, runs the A1.4 sanity checks, and swaps the partitions in one transaction —
 * or, with --dry-run, does everything except the swap and reports what would have
 * happened. While the count band is unfitted (`sp_swap_sanity_v1`) a real swap requires
 * --confirm: the operator is the band.
 *
 * Exit codes: 0 — the run did what the flags asked (a dry run that would swap, or a
 * swap that happened); 1 — a sanity check failed, or a real run stopped short of the
 * swap; 2 — misconfiguration. Progress is canonical-JSON lines on stdout; the starting
 * line goes to stderr so piped output stays machine-readable.
 */

import { detectionUid } from '@fire-watch/contracts/node';

import { createFsSpArchiveReader } from '../adapters/promotion/fs-sp-archive-reader.js';
import { createOwnerPool } from '../adapters/promotion/pg-owner-pool.js';
import { createPgSpStagingStore } from '../adapters/promotion/pg-sp-staging-store.js';
import { backfillJob } from '../core/backfill/backfill-plan.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { noopMonthRecluster } from '../core/promotion/noop-month-recluster.js';
import { runPromotion } from '../core/promotion/promotion-run.js';
import { ConfigError } from './config.js';
import { processLog } from './logging.js';
import {
  describeSpPromotionConfig,
  loadSpPromotionConfig,
  parsePromotionArgs,
} from './sp-promotion-config.js';

const EXIT_MISCONFIGURED = 2;

/** Redacting from the first line — this job holds the owner-role DATABASE_URL (C8). */
const log = processLog();

async function main(): Promise<number> {
  const options = parsePromotionArgs(process.argv.slice(2));
  const config = loadSpPromotionConfig(process.env);
  const job = backfillJob();

  log.note({
    starting: {
      ...describeSpPromotionConfig(config),
      month: options.month,
      mode: options.dryRun ? 'dry_run' : 'swap',
      operator_confirmed: String(options.operatorConfirmed),
      plan: job.plan,
      plan_digest: job.planDigest,
    },
  });

  const pool = createOwnerPool({
    databaseUrl: config.databaseUrl,
    applicationName: 'fire-watch-sp-promotion',
  });
  const writeLine = (line: string): void => {
    log.line(line);
  };

  try {
    const summary = await runPromotion(options, job, {
      archive: createFsSpArchiveReader(config.archiveDir),
      staging: createPgSpStagingStore(pool),
      recluster: noopMonthRecluster,
      detectionUid,
      writeLine,
    });

    writeLine(
      canonicalJson({
        sp_promotion_run: {
          month: summary.month,
          mode: summary.mode,
          staged_rows: summary.stagedRows,
          verdict: summary.verdict,
          decision: summary.decision,
          retired_table: summary.swap?.retiredTable ?? null,
          attached_partition: summary.swap?.attachedPartition ?? null,
          recluster: summary.recluster?.status ?? null,
        },
      }),
    );

    if (summary.decision === 'blocked_failed') return 1;
    if (!options.dryRun && summary.decision !== 'swapped') return 1;
    return 0;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
