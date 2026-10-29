/**
 * Per-source staleness (TASKS F4, half 2) — a pure selector over `StoreState.sources`.
 *
 * A source is stale when its last observation is older than that source's threshold,
 * measured in server time (`ServerNow`, ADR-003 A1.6), never the device clock. `null` is
 * **unarmed** (never reported stale).
 *
 * Founder decision 2026-10-30 (docs/decisions/founder-2026-10-30/thresholds-ops.md F4-a/b):
 * the three VIIRS satellites are armed at 36 h; every other source stays unarmed. The
 * value follows overpass cadence: each VIIRS satellite crosses Bulgaria about twice a day,
 * so three satellites give roughly six looks a day, and a full day and a half without one
 * detection on any of them is rarer than a cloudy night — but still most often "no fires or
 * cloud", which is why the surface is a descriptive note in the layers panel and never the
 * banner slot (GLOSSARY §3b: "one late source is a layers-panel dot, never a banner").
 * MODIS is not a monitored row; SLSTR, the geostationary sources and the reserved ids are
 * not live yet, and arming a source that produces nothing would report it stale forever.
 */

import { SOURCE_IDS, isSourceId, type SourceId } from '@fire-watch/contracts';

import type { SnapshotSourceRow } from '../types.js';

/** Staleness threshold per source, in ms; `null` = unarmed (never reported stale). */
export type SourceStalenessThresholds = Readonly<Record<SourceId, number | null>>;

/** F4-a: the VIIRS staleness threshold, 36 h of server time. */
export const VIIRS_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

/** The sources the F4 note speaks for: the VIIRS family, armed together. */
export const VIIRS_SOURCE_IDS: readonly SourceId[] = [
  'firms:viirs:snpp',
  'firms:viirs:noaa20',
  'firms:viirs:noaa21',
];

/** VIIRS armed at 36 h (F4-a); every other source unarmed. */
export const SOURCE_STALENESS_THRESHOLDS_MS: SourceStalenessThresholds = Object.freeze(
  Object.fromEntries(
    SOURCE_IDS.map((id) => [id, VIIRS_SOURCE_IDS.includes(id) ? VIIRS_STALE_AFTER_MS : null]),
  ) as Record<SourceId, number | null>,
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

/**
 * F4-b: the instant the layers-panel note cites, or `null` for no note. A note renders only
 * when **every** VIIRS row the snapshot carries is stale — one quiet satellite while its
 * siblings report is ordinary orbit geometry, not news — and it cites the newest
 * observation across them ("last VIIRS detection"). `null` as well when no VIIRS row is
 * present (no snapshot yet) or when none was ever observed: there is no honest age to
 * print, and the copy for "never" is not decided (the selector still reports those rows).
 */
export function viirsQuietSince(
  sources: readonly SnapshotSourceRow[],
  thresholds: SourceStalenessThresholds,
  serverNowMs: number,
): string | null {
  const viirs: readonly string[] = VIIRS_SOURCE_IDS;
  const rows = sources.filter((row) => viirs.includes(row.sourceId));
  if (rows.length === 0) return null;
  if (staleSources(rows, thresholds, serverNowMs).length !== rows.length) return null;
  let newest: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    // Every non-null instant here parsed inside `staleSources` (an unparseable one would
    // have been skipped there and failed the length check above).
    const ms = row.lastObservedAt === null ? Number.NaN : Date.parse(row.lastObservedAt);
    if (ms > newestMs) {
      newestMs = ms;
      newest = row.lastObservedAt;
    }
  }
  return newest;
}
