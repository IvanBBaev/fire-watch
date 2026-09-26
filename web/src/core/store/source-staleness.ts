/**
 * Per-source staleness (TASKS F4, half 2) — a pure selector over `StoreState.sources`.
 *
 * A source is stale when its last observation is older than that source's threshold,
 * measured in server time (`ServerNow`, ADR-003 A1.6), never the device clock. Each
 * threshold is `null` — **unarmed** — until the founder decides it: the VIIRS value turns
 * on overpass cadence (a polar orbiter passes a few times a day, so "no detection for N
 * hours" is normal night and cloud, not a fault), and whatever the selector reports needs
 * copy that does not exist yet. Until then this selector returns nothing for every source
 * and nothing renders it; the plumbing exists so arming a source is a one-line change
 * plus copy, not a data-flow change.
 */

import { SOURCE_IDS, isSourceId, type SourceId } from '@fire-watch/contracts';

import type { SnapshotSourceRow } from '../types.js';

/** Staleness threshold per source, in ms; `null` = unarmed (never reported stale). */
export type SourceStalenessThresholds = Readonly<Record<SourceId, number | null>>;

/**
 * Every source unarmed. Founder decisions pending: the VIIRS threshold (overpass cadence)
 * and the copy for a stale source; the other sources follow once VIIRS sets the pattern.
 */
export const SOURCE_STALENESS_THRESHOLDS_MS: SourceStalenessThresholds = Object.freeze(
  Object.fromEntries(SOURCE_IDS.map((id) => [id, null])) as Record<SourceId, number | null>,
);

export interface StaleSource {
  readonly sourceId: SourceId;
  /** `null` when the source has never been observed. */
  readonly lastObservedAt: string | null;
  /** Server-time age of the last observation; `null` when never observed. */
  readonly ageMs: number | null;
  readonly thresholdMs: number;
}

/**
 * The armed sources whose last observation is older than their threshold, in the order
 * `sources` lists them. A row is stale when its age is **strictly** greater than the
 * threshold, or when it was never observed (`lastObservedAt: null`) — an armed source
 * that has produced nothing is the loudest case of stale, not an exempt one. Skipped:
 * unarmed sources, ids outside the frozen registry, and unparseable instants (the feed
 * adapter guards the wire; guessing an age from garbage would be a lie either way).
 * A future instant (clock skew) has a negative age and is fresh.
 */
export function staleSources(
  sources: readonly SnapshotSourceRow[],
  thresholds: SourceStalenessThresholds,
  serverNowMs: number,
): readonly StaleSource[] {
  const stale: StaleSource[] = [];
  for (const row of sources) {
    if (!isSourceId(row.sourceId)) continue;
    const thresholdMs = thresholds[row.sourceId];
    if (thresholdMs === null) continue;
    if (row.lastObservedAt === null) {
      stale.push({ sourceId: row.sourceId, lastObservedAt: null, ageMs: null, thresholdMs });
      continue;
    }
    const observedMs = Date.parse(row.lastObservedAt);
    if (Number.isNaN(observedMs)) continue;
    const ageMs = serverNowMs - observedMs;
    if (ageMs > thresholdMs) {
      stale.push({
        sourceId: row.sourceId,
        lastObservedAt: row.lastObservedAt,
        ageMs,
        thresholdMs,
      });
    }
  }
  return stale;
}
