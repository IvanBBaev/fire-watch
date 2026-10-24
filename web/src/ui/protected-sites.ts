/**
 * Natura 2000 protected sites in the browser (V2-F1): every Special Protection Area (Birds
 * Directive) and Site of Community Importance (Habitats Directive) in the served box, from
 * the EEA's Natura 2000 dataset (CC BY 4.0), cut by `infra/geodata/natura2000.ts`.
 *
 * Two readers use it:
 * - the event detail, which says "inside protected site <name> (<code>)" or "N km from …"
 *   (`core/geo/protected-sites.ts` has the rule);
 * - the Layers panel, which can draw the sites on the map.
 *
 * The asset (~190 KiB gzip) is a build file served from our own origin, fetched the first
 * time either reader needs it — never at boot (CI-12 lists it in `ON_DEMAND_DATA`). The
 * geometry code (`core/geo/protected-sites.ts`) is imported with it, dynamically, so it
 * stays out of the critical path too: readers get it through {@link protectedSitesGeo}. Same
 * shape as `static-sources.ts`: an idempotent load, a state signal, a retry after a
 * failure. The layer choice is persisted (`fw:protected-sites`) and travels in links as
 * the `natura` token of `ov=`.
 */

import { computed, signal } from '@preact/signals';
import { CREDITS, type Credit } from '@fire-watch/contracts';

import natura2000Url from '../assets/geodata/natura2000.json?url';
import type {
  ProtectedSites,
  ProtectedSitesGeoJson,
  protectedSiteRelation,
  protectedSitesGeoJson,
} from '../core/geo/protected-sites.js';
import { readStorage, writeStorage } from './storage.js';

export const PROTECTED_SITES_STORAGE_KEY = 'fw:protected-sites';

export type ProtectedSitesState = 'idle' | 'loading' | 'ready' | 'failed';
export const protectedSitesState = signal<ProtectedSitesState>('idle');
/** Empty until loaded; empty sites produce no note and draw nothing. */
const EMPTY: ProtectedSites = {
  version: 'none',
  licence: '',
  attribution: '',
  sites: [],
  grid: new Map(),
};
export const protectedSites = signal<ProtectedSites>(EMPTY);

/** The geometry functions, once loaded with the sites; `null` before. */
export interface ProtectedSitesGeo {
  readonly protectedSiteRelation: typeof protectedSiteRelation;
  readonly protectedSitesGeoJson: typeof protectedSitesGeoJson;
}
export const protectedSitesGeo = signal<ProtectedSitesGeo | null>(null);

let load: Promise<void> | null = null;

/** Idempotent while a load is in flight or done; a failed load may be retried. */
export function loadProtectedSites(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (load !== null) return load;
  protectedSitesState.value = 'loading';
  load = Promise.all([import('../core/geo/protected-sites.js'), fetchImpl(natura2000Url)])
    .then(async ([geo, response]) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      protectedSites.value = geo.parseProtectedSites((await response.json()) as unknown);
      protectedSitesGeo.value = geo;
      protectedSitesState.value = 'ready';
    })
    .catch(() => {
      protectedSitesState.value = 'failed';
      load = null;
    });
  return load;
}

// ── The Layers-panel choice ─────────────────────────────────────────────────

export const protectedSitesChosen = signal(readStorage(PROTECTED_SITES_STORAGE_KEY) === 'on');

export function setProtectedSitesChosen(on: boolean): void {
  protectedSitesChosen.value = on;
  writeStorage(PROTECTED_SITES_STORAGE_KEY, on ? 'on' : 'off');
  if (on) void loadProtectedSites();
}

/**
 * Apply the choice a link states (`ov=…,natura`, `url-state.ts`). Never writes storage:
 * someone else's link must not overwrite the reader's own `fw:protected-sites`.
 */
export function applyProtectedSitesFromLink(on: boolean): void {
  if (protectedSitesChosen.peek() !== on) protectedSitesChosen.value = on;
  if (on) void loadProtectedSites();
}

/** What the map draws: the sites while the layer is on and loaded, otherwise nothing. */
export const protectedSitesDraw = computed<ProtectedSitesGeoJson | null>(() => {
  const geo = protectedSitesGeo.value;
  return protectedSitesChosen.value && protectedSitesState.value === 'ready' && geo !== null
    ? geo.protectedSitesGeoJson(protectedSites.value)
    : null;
});

/** The EEA credit the sites are paid for with (contracts registry), never retyped. */
export function protectedSitesCredit(): Pick<Credit, 'text' | 'href'> | null {
  return CREDITS.find((entry) => entry.id === 'eea-natura2000') ?? null;
}

export function resetProtectedSitesForTest(): void {
  load = null;
  protectedSitesState.value = 'idle';
  protectedSites.value = EMPTY;
  protectedSitesGeo.value = null;
  protectedSitesChosen.value = false;
}
