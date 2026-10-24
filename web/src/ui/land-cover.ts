/**
 * Land cover in the browser (V2-F4): ESA WorldCover 2021 group shares on a 0.02° grid over
 * the served box (CC BY 4.0), cut from the DS-7 product by
 * `infra/geodata/landcover-web.ts`. The event detail reads it to say what land lies under
 * the detections (`core/geo/land-cover.ts` has the rule and builds the sentence).
 *
 * The asset (~155 KiB gzip) is a build file served from our own origin, fetched the first
 * time an event is opened — never at boot (CI-12 lists it in `ON_DEMAND_DATA`). The grid
 * code is imported with it, dynamically, so it stays out of the critical path too. This
 * module is deliberately small, because it is on that path: one signal holding the
 * sentence function bound to the loaded grid, and an idempotent load that a failure
 * resets so a later call retries.
 */

import { signal } from '@preact/signals';

import landCoverUrl from '../assets/geodata/landcover.json?url';
import type { Messages } from '../core/i18n/messages.js';

/** The sentence for the land under `points`, or `null` when there is nothing to say. */
export type LandCoverSentence = (
  points: readonly { readonly lon: number; readonly lat: number }[],
  t: Messages['eventDetail'],
) => string | null;

/** Set once the grid has loaded; `null` before, and after a failed load. */
export const landCoverSentence = signal<LandCoverSentence | null>(null);

let load: Promise<void> | null = null;

/** Idempotent while a load is in flight or done; a failed load may be retried. */
export function loadLandCover(fetchImpl: typeof fetch = fetch): Promise<void> {
  load ??= Promise.all([
    import('../core/geo/land-cover.js'),
    // No `ok` check: an error page is not the asset, so `json()` or the parser rejects it.
    fetchImpl(landCoverUrl).then((response) => response.json() as Promise<unknown>),
  ])
    .then(([geo, json]) => {
      const grid = geo.parseLandCover(json);
      landCoverSentence.value = (points, t) => geo.landCoverSentence(grid, points, t);
    })
    .catch(() => {
      load = null;
    });
  return load;
}

export function resetLandCoverForTest(): void {
  load = null;
  landCoverSentence.value = null;
}
