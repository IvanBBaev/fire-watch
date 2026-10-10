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
