/**
 * `lightning_context_v1` — the window the event page's lightning context looks at
 * (TASKS F18; DATA-SOURCES §F18).
 *
 * The page says how many MTG-LI flashes fell within `radiusKm` of the event in the
 * `windowHours` before its first detection. **Context, never cause** (GLOSSARY §5.2):
 * a nearby flash before a fire is consistent with many stories, and LI's detection
 * efficiency (about 70 % by day, 95 % by night; DATA-SOURCES-EXTENDED K6) means an empty
 * window is not proof of an empty sky either. The copy says both.
 *
 * Founder decision: 10 km and 3 h are a judgement, not a published number. 10 km is a few
 * LI pixels (about 4.5 km at the sub-satellite point, wider over Europe) plus the event's
 * own extent; 3 h keeps the statement about the storm that was overhead, not the day.
 * Holdover fires — a strike smouldering for one to three days before it is seen — fall
 * outside any window the nine-hour document can serve; that is a known gap, not a choice.
 */

import { defineConfig, type VersionedConfig } from './versioned-config.js';

export interface LightningContextValues {
  /** Flashes within this great-circle distance of the event centroid are counted. */
  readonly radiusKm: number;
  /** How far before the first detection the window starts. */
  readonly windowHours: number;
  /**
   * The largest gap between consecutive merged products that still counts as covered. LI
   * products are 10-minute windows that abut; anything wider is a missing product.
   */
  readonly maxGapSeconds: number;
  /** Events evaluated per loop cycle; the rest wait for the next one. */
  readonly batchSize: number;
}

export const LIGHTNING_CONTEXT: VersionedConfig<LightningContextValues> = defineConfig(
  'lightning_context',
  'lightning_context_v1',
  { radiusKm: 10, windowHours: 3, maxGapSeconds: 60, batchSize: 200 },
);

/**
 * How far an event may move after its context was computed before the context is computed
 * again (TASKS F18). The centroid drifts as detections join the event, and the first
 * detection moves earlier when an older event is merged into it; a count for a point or a
 * window the event no longer has is a statement about another place or another storm.
 *
 * Not part of `lightning_context_v1`: these decide *when* the number is recomputed, never
 * what it is, so changing them must not invalidate every stored row the way a params
 * version bump does.
 *
 * Founder decision: 1 km is a tenth of the radius and a fraction of one LI pixel (~4.5 km),
 * so a smaller move is inside the flashes' own position uncertainty; 60 s matches the
 * coverage gap tolerance.
 *
 * A recompute follows the normal rules. While the new window is still inside the
 * document's retention the stored row stays until the new answer is known; once it has
 * aged out the honest answer for the new point is `unavailable` until the archive backfill
 * (`lightning-context-backfill.ts`) fetches the products again.
 */
export interface LightningContextDrift {
  readonly centroidKm: number;
  readonly firstDetectionMs: number;
}

export const LIGHTNING_CONTEXT_DRIFT: LightningContextDrift = Object.freeze({
  centroidKm: 1,
  firstDetectionMs: 60_000,
});
