/**
 * `lightning_filter_v1` — which decoded MTG-LI flashes the F18 overlay and event context
 * count (TASKS F18; DATA-SOURCES §F18).
 *
 * **What the product says.** Each LFL flash carries `flash_filter_confidence`, a byte
 * scaled by 0.004 into [0, 1] where "0 means high confidence of a true flash and 1 means
 * low confidence" (EUMETSAT MTG LI L2 Product User Guide, EUM/MTG/SPE/10/0452 v5C,
 * Annex A.6). The decoder passes it through as `falseLikelihood` — the inverted name keeps
 * a high value from being read as a good flash. Neither the PUG nor the ESSL LI
 * Application Guide (v3.1.4) gives a cut-off; the Application Guide states the delivered
 * flashes already run at fewer than 0.1 false flashes per second over the disc, i.e.
 * "false detections are very rare".
 *
 * **The choice.** A flash is dropped only when the product itself rates it more likely
 * false than true (`falseLikelihood > maxFalseLikelihood`, 0.5). That removes the flashes
 * the product flags without second-guessing its own filtering, which is already applied
 * before delivery. A flash with no value is kept (`keepUnrated`) and counted separately,
 * so an unrated share that grows is visible rather than silently included or dropped.
 * Founder decision: the threshold is a judgement, not a published number; a stricter
 * value needs evidence from real granules (all F18 work so far is on synthetic ones).
 *
 * Records keep every flash with its value; the filter is applied when the rolling document
 * is built and the document records this version, so changing it never needs a re-fetch —
 * a document written under another version is rebuilt from the stored records.
 */

import { defineConfig, type VersionedConfig } from './versioned-config.js';

export interface LightningFilterValues {
  /** Flashes whose `falseLikelihood` exceeds this are dropped. */
  readonly maxFalseLikelihood: number;
  /** Whether a flash without a `falseLikelihood` is kept. */
  readonly keepUnrated: boolean;
}

export const LIGHTNING_FILTER: VersionedConfig<LightningFilterValues> = defineConfig(
  'lightning_filter',
  'lightning_filter_v1',
  { maxFalseLikelihood: 0.5, keepUnrated: true },
);

export type LightningFilterVerdict = 'kept' | 'kept_unrated' | 'dropped';

/** How one flash fares under the filter. */
export function judgeFlash(
  falseLikelihood: number | null,
  values: LightningFilterValues = LIGHTNING_FILTER.values,
): LightningFilterVerdict {
  if (falseLikelihood === null) return values.keepUnrated ? 'kept_unrated' : 'dropped';
  return falseLikelihood > values.maxFalseLikelihood ? 'dropped' : 'kept';
}
