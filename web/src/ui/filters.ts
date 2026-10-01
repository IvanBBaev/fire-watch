/**
 * The reader's source and region filters, shared by the filter bar that sets them, the
 * list that obeys them and the map that draws them — signals for the same reason as the
 * time window (`age-window.ts`): the map is mounted above the router, and lifting the
 * state through the shell would re-render the map container on every change.
 *
 * **URL.** All three filters live in the fragment (`core/filter/filter-hash.ts`), so a
 * filtered view is a shareable link. At boot the fragment outranks storage, member by
 * member, and applying it never writes storage: opening someone else's link must not
 * overwrite the reader's own remembered window. Only a choice the reader makes writes
 * storage. A hand-edited fragment is picked up on `hashchange`.
 *
 * **Storage.** Only the time window is remembered across visits (`fw.age-window`, as
 * before). Source and region are deliberately not: a region narrowed last week and
 * silently re-applied today would hide fires the reader no longer knows are filtered
 * out. They survive a reload through the fragment, which the reader can see.
 *
 * **Oblast polygons** (~8 KiB gzip) load on first need — a region chosen here or in a
 * link — never at boot. Until they arrive the region filter fails open and the bar says
 * it is still loading.
 */

import { effect, signal } from '@preact/signals';

import type { OblastIndex } from '../core/filter/oblasts.js';
import { createOblastIndex, isRegionsAsset } from '../core/filter/oblasts.js';
import type { FilterSelection } from '../core/filter/filter-hash.js';
import { parseFilterHash, withFilterHash } from '../core/filter/filter-hash.js';
import type { SourceFamily } from '../core/filter/source-families.js';
import oblastsUrl from '../assets/geodata/oblasts.json?url';
import { ageWindow } from './age-window.js';

export const sourceFamily = signal<SourceFamily | null>(null);
export const regionFilter = signal<number | null>(null);

export type RegionIndexState = 'idle' | 'loading' | 'ready' | 'failed';
export const regionIndexState = signal<RegionIndexState>('idle');
export const regionIndex = signal<OblastIndex | null>(null);

export function setSourceFamily(next: SourceFamily | null): void {
  sourceFamily.value = next;
}

export function setRegionFilter(next: number | null): void {
  regionFilter.value = next;
  if (next !== null) void loadRegionIndex();
}

/** Back to the defaults for source and region; the time window has its own "show older". */
export function clearScopeFilters(): void {
  sourceFamily.value = null;
  regionFilter.value = null;
}

export function currentSelection(): FilterSelection {
  return { window: ageWindow.value, family: sourceFamily.value, oblast: regionFilter.value };
}

let regionLoad: Promise<void> | null = null;

/** Idempotent; a failed load may be retried by the next call. */
export function loadRegionIndex(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (regionLoad !== null) return regionLoad;
  regionIndexState.value = 'loading';
  regionLoad = fetchImpl(oblastsUrl)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const asset: unknown = await response.json();
      if (!isRegionsAsset(asset)) throw new Error('malformed oblasts asset');
      regionIndex.value = createOblastIndex(asset);
      regionIndexState.value = 'ready';
    })
    .catch(() => {
      regionIndexState.value = 'failed';
      regionLoad = null;
    });
  return regionLoad;
}

/**
 * Apply what a fragment says. Members it does not mention are left as they are, so a
 * `#map=…`-only link (every link written before the filters existed) changes nothing.
 * Never writes storage.
 */
export function applyFilterHash(hash: string): void {
  const parsed = parseFilterHash(hash);
  if (parsed.window !== undefined) ageWindow.value = parsed.window;
  if (parsed.family !== undefined) sourceFamily.value = parsed.family;
  if (parsed.oblast !== undefined) setRegionFilter(parsed.oblast);
}

/**
 * Start mirroring the filters into the fragment, after applying the fragment the page
 * opened with. Returns the stop function. `replaceState` keeps the route path, the query
 * and every other fragment member (the camera's `map=`, a sign-in `token=`), and fires no
 * `hashchange`, so the two directions cannot chase each other.
 */
export function startFilterUrlSync(): () => void {
  applyFilterHash(location.hash);
  const onHashChange = (): void => {
    applyFilterHash(location.hash);
  };
  window.addEventListener('hashchange', onHashChange);
  const stopEffect = effect(() => {
    const selection: FilterSelection = {
      window: ageWindow.value,
      family: sourceFamily.value,
      oblast: regionFilter.value,
    };
    const next = withFilterHash(location.hash, selection);
    const current = location.hash === '#' ? '' : location.hash;
    if (next === current) return;
    history.replaceState(
      history.state,
      '',
      next === '' ? location.pathname + location.search : next,
    );
  });
  return () => {
    window.removeEventListener('hashchange', onHashChange);
    stopEffect();
  };
}
