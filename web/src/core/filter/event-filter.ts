/**
 * The reader's filters — time window, sensor family, oblast — applied as one rule that
 * both the list and the map obey, so neither can show a fire the other denies.
 *
 * Display filters, not judgements: nothing here touches the store or decides lifecycle
 * (ADR-003 A1.4/R1), and every hidden row is counted out loud, split by *why* it is
 * hidden, so the list can say "3 older hidden" and "5 hidden by filters" separately and
 * offer the matching way back. The list may narrow; it may never silently shrink.
 *
 * Fail-open rules, both honest about what the client does not know:
 * - An event whose sources are *unreported* passes every family filter and is counted as
 *   such. Unreported is: no `sourceIds` (the server serves `source_ids: null` when
 *   `fire_events.source_mix` is empty, and a pre-F12 cached body has no field at all), or
 *   ids none of which this build can place in a family (an empty list, or only sources
 *   added to the append-only registry after this bundle shipped). Hiding those would make
 *   the filter read "no VIIRS fires" when the truth is "the feed did not say" — or "said,
 *   in words this build does not know yet".
 * - Until the oblast polygons have loaded (`regionAt === null`), the region filter passes
 *   everything; the bar shows that the region is still loading.
 */

import { isWithinCutoff } from '../time/age-filter.js';
import type { FireEvent } from '../types.js';
import type { SourceFamily } from './source-families.js';
import { SOURCE_FAMILIES, familyOfSource } from './source-families.js';

export interface EventFilterState {
  /** Instant from `ageCutoffMs`, or `null` for no time bound. */
  readonly cutoffMs: number | null;
  readonly family: SourceFamily | null;
  /** ISO 3166-2:BG number, or `null` for the whole map. */
  readonly oblast: number | null;
}

/** Point → oblast number, or `null` while the polygons are not loaded. */
export type RegionLookup = ((lon: number, lat: number) => number | null) | null;

type Filterable = Pick<FireEvent, 'lat' | 'lon' | 'lastObservedAt' | 'sourceIds'>;

/**
 * The families that saw the event, or `null` when its sources are unreported — absent, or
 * with no id this build maps to a family (see the fail-open rules above). An event with
 * one known and one unknown id is placed by the known one alone.
 */
export function familiesOf(event: Pick<FireEvent, 'sourceIds'>): ReadonlySet<SourceFamily> | null {
  if (event.sourceIds === undefined) return null;
  const families = new Set<SourceFamily>();
  for (const id of event.sourceIds) {
    const family = familyOfSource(id);
    if (family !== null) families.add(family);
  }
  return families.size === 0 ? null : families;
}

export function matchesFamily(event: Filterable, family: SourceFamily | null): boolean {
  if (family === null) return true;
  const families = familiesOf(event);
  return families === null || families.has(family);
}

export function matchesRegion(
  event: Filterable,
  oblast: number | null,
  regionAt: RegionLookup,
): boolean {
  if (oblast === null || regionAt === null) return true;
  return regionAt(event.lon, event.lat) === oblast;
}

/** Source and region only — the part of the filter that is not the time window. */
export function matchesScope(
  event: Filterable,
  state: Pick<EventFilterState, 'family' | 'oblast'>,
  regionAt: RegionLookup,
): boolean {
  return matchesFamily(event, state.family) && matchesRegion(event, state.oblast, regionAt);
}

export function matchesFilter(
  event: Filterable,
  state: EventFilterState,
  regionAt: RegionLookup,
): boolean {
  return isWithinCutoff(event, state.cutoffMs) && matchesScope(event, state, regionAt);
}

/** `null` when nothing but the time window is set — the map then needs no predicate. */
export function scopePredicate(
  state: Pick<EventFilterState, 'family' | 'oblast'>,
  regionAt: RegionLookup,
): ((event: Filterable) => boolean) | null {
  if (state.family === null && (state.oblast === null || regionAt === null)) return null;
  return (event) => matchesScope(event, state, regionAt);
}

export interface FilterPartition<T> {
  /** Passes all three filters, in the caller's order. */
  readonly visible: readonly T[];
  /** In scope (source + region) but outside the time window — "N older hidden". */
  readonly olderCount: number;
  /** Left out by the source or region filter — "M hidden by filters". */
  readonly filteredCount: number;
}

/**
 * Split by the filters, preserving input order. An event failing both the window and the
 * scope is counted as *filtered*, not older: widening the window would not bring it back,
 * so "show older" must not promise it.
 */
export function partitionEvents<T extends Filterable>(
  items: readonly T[],
  state: EventFilterState,
  regionAt: RegionLookup,
): FilterPartition<T> {
  const visible: T[] = [];
  let olderCount = 0;
  let filteredCount = 0;
  for (const item of items) {
    if (!matchesScope(item, state, regionAt)) filteredCount++;
    else if (!isWithinCutoff(item, state.cutoffMs)) olderCount++;
    else visible.push(item);
  }
  return { visible, olderCount, filteredCount };
}

export interface FamilyCounts {
  readonly byFamily: Readonly<Record<SourceFamily, number>>;
  /** Events counted under no family because their sources are unreported (`familiesOf`). */
  readonly unreported: number;
  /** Events in window and region — what "All sources" shows. */
  readonly total: number;
}

/**
 * Live counts for the source picker, over the events that pass the *other* two filters
 * (window and region), so each option says how many fires choosing it would show. An
 * event seen by two families counts under both — the options are not a partition.
 */
export function countFamilies(
  items: readonly Filterable[],
  state: Pick<EventFilterState, 'cutoffMs' | 'oblast'>,
  regionAt: RegionLookup,
): FamilyCounts {
  const byFamily: Record<SourceFamily, number> = { v: 0, m: 0, s: 0, g: 0 };
  let unreported = 0;
  let total = 0;
  for (const item of items) {
    if (!isWithinCutoff(item, state.cutoffMs)) continue;
    if (!matchesRegion(item, state.oblast, regionAt)) continue;
    total++;
    const families = familiesOf(item);
    if (families === null) {
      unreported++;
      continue;
    }
    for (const family of SOURCE_FAMILIES) {
      if (families.has(family)) byFamily[family]++;
    }
  }
  return { byFamily, unreported, total };
}
