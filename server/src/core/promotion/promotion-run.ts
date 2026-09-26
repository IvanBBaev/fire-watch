/**
 * One month's NRT→SP promotion, end to end (ADR-002 D7 as amended by A1.4; TASKS C7).
 *
 * The sequence is the amendment's, in its order: stage the month's SP rows beside the
 * live partition, measure, run the sanity gate, and only then — with every check green
 * and the operator's confirmation where the unfitted band demands it — swap the
 * partitions in one transaction and invoke the re-cluster hook. `--dry-run` walks the
 * identical path up to and *excluding* the swap: the staging table is really built and
 * really checked, and the summary says what would have happened, so a dry run is a
 * rehearsal, not a simulation.
 *
 * A promotion run emits zero alerts by construction (invariant I4): no alert port is
 * even injectable here, so re-clustering-era code cannot regress this by accident.
 */

import { POLLING_BBOX } from '../config/polling-bbox.js';
import { parseManifest } from '../backfill/backfill-manifest.js';
import type { BackfillJob } from '../backfill/backfill-plan.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import type { DetectionUidFn } from '../ports/firms-client.js';
import type { MonthRecluster, MonthReclusterResult } from '../ports/month-recluster.js';
import type { SpArchiveReader } from '../ports/sp-archive-reader.js';
import type { SpStagingStore, SwapOutcome } from '../ports/sp-staging-store.js';
import { monthWindow } from './month-window.js';
import type { CheckStatus, SanityReport } from './sanity-checks.js';
import { decideSwap, evaluateSanityChecks } from './sanity-checks.js';
import { stageMonth } from './stage-month.js';

export interface PromotionOptions {
  /** `YYYY-MM`. */
  readonly month: string;
  /** Stage and check for real, report what would swap, and never call `swap`. */
  readonly dryRun: boolean;
  /** The operator's explicit yes — what A1.4 requires while the bands are unfitted. */
  readonly operatorConfirmed: boolean;
}

export interface PromotionDeps {
  readonly archive: SpArchiveReader;
  readonly staging: SpStagingStore;
  readonly recluster: MonthRecluster;
  readonly detectionUid: DetectionUidFn;
  /** One canonical-JSON line per step — the run's progress protocol on stdout. */
  readonly writeLine: (line: string) => void;
}

export type PromotionDecision =
  'swapped' | 'would_swap' | 'blocked_needs_operator' | 'blocked_failed';

export interface PromotionSummary {
  readonly month: string;
  readonly mode: 'dry_run' | 'swap';
  readonly stagedRows: number;
  readonly report: SanityReport;
  readonly verdict: CheckStatus;
  readonly decision: PromotionDecision;
  /** Set when and only when the swap actually happened. */
  readonly swap: SwapOutcome | null;
  readonly recluster: MonthReclusterResult | null;
}

export async function runPromotion(
  options: PromotionOptions,
  job: BackfillJob,
  deps: PromotionDeps,
): Promise<PromotionSummary> {
  const window = monthWindow(options.month);
  const mode = options.dryRun ? 'dry_run' : 'swap';

  const manifestText = await deps.archive.readManifest();
  if (manifestText === null) {
    throw new Error(
      `cannot promote ${window.month}: the archive has no manifest — run the backfill first`,
    );
  }
  // parseManifest refuses a manifest written under a different plan, digest, area or
  // bbox version — promoting from an archive the current plan does not describe is a
  // provenance error, not a recoverable condition.
  const manifest = parseManifest(manifestText, job);

  const staged = await stageMonth(window, job, manifest, {
    archive: deps.archive,
    detectionUid: deps.detectionUid,
  });
  deps.writeLine(
    canonicalJson({
      sp_promotion_staged: {
        month: window.month,
        staging_table: window.stagingTable,
        chunks_read: staged.chunksRead,
        rows_parsed: staged.rowsParsed,
        rows_staged: staged.records.length,
        rows_outside_month: staged.rowsOutsideMonth,
        rows_rejected: staged.rowsRejected,
        duplicates_within_month: staged.duplicatesWithinMonth,
      },
    }),
  );

  await deps.staging.prepareStaging(window);
  const loaded = await deps.staging.loadStaged(window, staged.records);
  const observations = await deps.staging.observe(window, POLLING_BBOX.values);
  const report = evaluateSanityChecks(observations);

  for (const check of report.checks) {
    deps.writeLine(
      canonicalJson({
        sp_swap_check: {
          month: window.month,
          check: check.check,
          status: check.status,
          detail: check.detail,
        },
      }),
    );
  }

  const base = {
    month: window.month,
    mode,
    stagedRows: loaded.received,
    report,
    verdict: report.verdict,
  } as const;

  const decision = decideSwap(report, options.operatorConfirmed);
  if (decision === 'blocked_failed') {
    // Fail-closed (A1.4 step 2): a failed check aborts and leaves NRT live.
    return { ...base, decision: 'blocked_failed', swap: null, recluster: null };
  }
  if (decision === 'blocked_needs_operator') {
    return { ...base, decision: 'blocked_needs_operator', swap: null, recluster: null };
  }
  if (options.dryRun) {
    // The staging table is left in place: what a dry run built is exactly what a
    // confirmed run would attach, and the operator may want to inspect it first.
    return { ...base, decision: 'would_swap', swap: null, recluster: null };
  }

  const swap = await deps.staging.swap(window);
  const recluster = await deps.recluster.reclusterMonth({ month: window.month });
  return { ...base, decision: 'swapped', swap, recluster };
}
