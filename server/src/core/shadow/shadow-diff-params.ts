/**
 * `shadow_diff_v1` — every number the nightly shadow diff is allowed to consult (TASKS H8;
 * IP WP6; 06 §5.7; GATES L-1).
 *
 * The shadow diff is the evidence L-1 promotes on: "nightly diff reviewed, every diff
 * explained". A report whose matching rule could be tuned in place would let the number of
 * diffs to explain move without the pipeline changing, so the rule is versioned data and
 * every report carries this config's version and digest — the same argument
 * `qa_metrics_v1` makes for CP1.
 *
 * ## What is deliberately *not* here
 *
 *   - DAR's suppression window lives in `alert_gating_v1`; the projected DAR in the report
 *     is `core/qa/dar.ts` run on each side, not a second definition.
 *   - The DAR targets live in `qa_metrics_v1`.
 *   - Which lifecycle states and score buckets exist is `@fire-watch/contracts`'s.
 */

import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';

export interface ShadowDiffParams {
  readonly matching: {
    /**
     * ADR-002 D7 step 5: "ID-preserving matching by detection-set Jaccard ≥ 0.5, greedy in
     * descending Jaccard, each old event claimed at most once". D7 states it for the
     * month re-cluster; the diff uses the same rule for the same reason — "without this
     * mechanic a shadow diff is a wall of renumbered ids". Inclusive: a pair at exactly
     * 0.5 matches.
     */
    readonly minJaccard: number;
  };
  readonly alerts: {
    /**
     * How far apart the live and the shadow `decided_at` of the *same* alert may be before
     * the difference is a diff line. **Unspecified — a founder decision.** `null` means
     * "any difference is a diff": both pipelines see the same detection stream on the
     * same ticks, so a behaviourally identical candidate decides at the same instant, and
     * the conservative reading of "every diff explained" is to show every shift rather
     * than pick a tolerance nobody signed.
     */
    readonly decidedAtToleranceMs: number | null;
  };
}

export const SHADOW_DIFF: VersionedConfig<ShadowDiffParams> = defineConfig(
  'shadow_diff',
  'shadow_diff_v1',
  {
    matching: { minJaccard: 0.5 },
    alerts: { decidedAtToleranceMs: null },
  },
);
