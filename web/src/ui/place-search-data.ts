/**
 * The settlement gazetteer (GeoNames, CC BY 4.0; ~65 KiB gzip), fetched the first time the
 * reader focuses the search box — never at boot, and never from a third party: the file is
 * a build asset served from our own origin, produced by `infra/geodata`.
 *
 * A failed load leaves coordinate search working and says so; the next focus retries.
 */

import { signal } from '@preact/signals';

import type { Gazetteer } from '../core/search/gazetteer.js';
import { createGazetteer, isGazetteerAsset } from '../core/search/gazetteer.js';
import settlementsUrl from '../assets/geodata/settlements.json?url';

export type GazetteerState = 'idle' | 'loading' | 'ready' | 'failed';
export const gazetteerState = signal<GazetteerState>('idle');
export const gazetteer = signal<Gazetteer | null>(null);

let load: Promise<void> | null = null;

/** Idempotent while a load is in flight or done; a failed load may be retried. */
export function loadGazetteer(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (load !== null) return load;
  gazetteerState.value = 'loading';
  load = fetchImpl(settlementsUrl)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const asset: unknown = await response.json();
      if (!isGazetteerAsset(asset)) throw new Error('malformed gazetteer asset');
      gazetteer.value = createGazetteer(asset);
      gazetteerState.value = 'ready';
    })
    .catch(() => {
      gazetteerState.value = 'failed';
      load = null;
    });
  return load;
}
