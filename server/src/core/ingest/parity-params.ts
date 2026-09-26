/**
 * `parity_check_v1` — every number the ingestion-parity check is allowed to consult (TASKS
 * C9; A23; 06 §5.5).
 *
 * The parity report is the evidence behind "we ingest what FIRMS publishes", so its
 * matching rule is versioned data and every report carries this config's version and
 * digest — the same argument `shadow_diff_v1` makes for L-1.
 *
 * ## The exact rule needs no number
 *
 * Two rows are the same detection when their `detection_uid`s are equal (GLOSSARY §1b):
 * the uid is a hash of source, acquisition minute and 5-dp coordinates, so a match is
 * exact by construction. What is deliberately *not* decided is whether a pair that
 * differs only by a rounding step or a re-processed timestamp counts as "the same fire
 * pixel, ingested" — see `nearMatch`.
 */

import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';

export interface ParityCheckParams {
  readonly nearMatch: {
    /**
     * How far apart the acquisition minutes of a missing reference row and an extra row of
     * ours may be for the two to be reported as a near match. **Unspecified — a founder
     * decision.** `null` (with `coordToleranceDeg` also `null`) turns near-matching off:
     * only equal uids match, and every other row is missing or extra. That is the
     * conservative reading of 06 §5.5's "any deficit > 0" — a tolerance nobody signed
     * would quietly shrink the deficit.
     */
    readonly acqToleranceMinutes: number | null;
    /**
     * The per-axis coordinate tolerance, in degrees, for the same pairing. **Unspecified —
     * a founder decision.** Both tolerances are null or both are set.
     */
    readonly coordToleranceDeg: number | null;
  };
}

export const PARITY_CHECK: VersionedConfig<ParityCheckParams> = defineConfig(
  'parity_check',
  'parity_check_v1',
  {
    nearMatch: { acqToleranceMinutes: null, coordToleranceDeg: null },
  },
);
