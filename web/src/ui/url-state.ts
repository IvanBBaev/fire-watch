/**
 * The app's state in the URL fragment, across route changes (TASKS F12):
 *
 *   /event/fw-2026-x4k6m#map=8.0/42.6977/23.3219&t=6h&src=v&r=22&ov=fwi
 *
 * Each owner writes only its own members with `replaceState` — the camera (`map=`, the
 * map controller after every gesture), the filters (`t=`/`src=`/`r=`, `filters.ts`) and
 * the context overlays (`ov=`, here). None of them hears about navigation, and none needs
 * to: the fragment is the thing that breaks. preact-iso pushes a link's `href`, which
 * never carries a fragment, so opening an event from the list used to leave only the
 * `map=` the next camera move happened to write, and the filters the reader was still
 * looking at dropped out of the link they would copy.
 *
 * {@link repairAppFragment} is the fix, run by the shell after every location change on a
 * map route: it fills in whichever of the app's members the new URL lacks, from the live
 * state, and overwrites nothing. On a Back step the entry returned to still carries its
 * own members, and those win (the filters' `hashchange` listener applies them). Panel
 * routes (settings, about, …) are left alone: they show none of this state, and their
 * links may carry a plain anchor (`/privacy#disclaimer`).
 *
 * **Overlays** follow the filters' URL rule: at boot the fragment outranks the remembered
 * choice and applying it never writes storage — someone else's link must not overwrite
 * the reader's own `fw:layers`; only a choice made in the panel does. The member is
 * written only when something is on, so a plain view keeps the short `#map=…` links. The
 * static hot-source mask (F16) shares the member as the `static` token and the same rule:
 * a link turns it on or off without touching `fw:static-sources`.
 */

import { effect } from '@preact/signals';

import type { FilterSelection } from '../core/filter/filter-hash.js';
import { filterHashMembers } from '../core/filter/filter-hash.js';
import type { MapCamera } from '../core/geo/viewport.js';
import {
  readFragmentMember,
  withFragmentMembers,
  withMissingFragmentMembers,
} from '../core/url-fragment.js';
import { mapHashMembers } from '../map/hash.js';
import { currentSelection } from './filters.js';
import type { OverlayId } from './layers.js';
import {
  chosenOverlays,
  formatLayersParam,
  formatOverlayParam,
  parseOverlayParam,
  parseProtectedSitesParam,
  parseStaticSourcesParam,
} from './layers.js';
import { mapViewport } from './map-camera.js';
import { applyProtectedSitesFromLink, protectedSitesChosen } from './protected-sites.js';
import { applyStaticSourcesFromLink, staticSourcesChosen } from './static-sources.js';

export const OVERLAY_HASH_KEY = 'ov';

/** The slices of `window.location` / `window.history` this module uses; faked in tests. */
export interface FragmentLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}
export interface FragmentHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | null): void;
}

/**
 * The `ov=` member for a choice; `null` (no member) when nothing is on. The static
 * hot-source mask (F16) and the Natura 2000 sites (V2-F1) ride in the same member as their
 * own tokens, after the overlays.
 */
export function overlayHashMembers(
  ids: readonly OverlayId[],
  staticSources = false,
  protectedSites = false,
): Record<string, string | null> {
  const spelled = formatLayersParam(ids, staticSources, protectedSites);
  return { [OVERLAY_HASH_KEY]: spelled === '' ? null : spelled };
}

/** What the fragment says about overlays; `null` when it says nothing. */
export function parseOverlayHash(hash: string): readonly OverlayId[] | null {
  return parseOverlayParam(readFragmentMember(hash, OVERLAY_HASH_KEY));
}

/** What the fragment says about the static hot-source mask; `null` when it says nothing. */
export function parseStaticSourcesHash(hash: string): boolean | null {
  return parseStaticSourcesParam(readFragmentMember(hash, OVERLAY_HASH_KEY));
}

/** What the fragment says about the protected sites; `null` when it says nothing. */
export function parseProtectedSitesHash(hash: string): boolean | null {
  return parseProtectedSitesParam(readFragmentMember(hash, OVERLAY_HASH_KEY));
}

/** Everything the app would write into the fragment right now, `null` where nothing. */
export interface AppFragmentState {
  /** `null` until the map has reported a frame — no camera is better than a guessed one. */
  readonly camera: MapCamera | null;
  readonly filters: FilterSelection;
  readonly overlays: readonly OverlayId[];
  /** The static hot-source mask layer (F16); absent reads as off. */
  readonly staticSources?: boolean;
  /** The Natura 2000 protected-site layer (V2-F1); absent reads as off. */
  readonly protectedSites?: boolean;
}

export function appFragmentMembers(state: AppFragmentState): Record<string, string | null> {
  return {
    ...(state.camera === null ? {} : mapHashMembers(state.camera)),
    ...filterHashMembers(state.filters),
    ...overlayHashMembers(
      state.overlays,
      state.staticSources ?? false,
      state.protectedSites ?? false,
    ),
  };
}

/** Replace the URL with `hash` when it differs; the path and query stay as they are. */
function replaceHash(loc: FragmentLocation, hist: FragmentHistory, hash: string): void {
  const current = loc.hash === '#' ? '' : loc.hash;
  if (hash === current) return;
  hist.replaceState(hist.state, '', hash === '' ? loc.pathname + loc.search : hash);
}

/**
 * Fill the members a navigation dropped back into the current URL (see the module note).
 * Pure over its arguments, so the round trip is testable without a browser.
 */
export function repairAppFragment(
  loc: FragmentLocation,
  hist: FragmentHistory,
  state: AppFragmentState,
): void {
  replaceHash(loc, hist, withMissingFragmentMembers(loc.hash, appFragmentMembers(state)));
}

/** The live state, read from the signals that own it. */
export function liveFragmentState(): AppFragmentState {
  return {
    camera: mapViewport.peek(),
    filters: currentSelection(),
    overlays: chosenOverlays.peek(),
    staticSources: staticSourcesChosen.peek(),
    protectedSites: protectedSitesChosen.peek(),
  };
}

/** Apply what a fragment says about overlays, the mask and the sites; never writes storage. */
export function applyOverlayHash(hash: string): void {
  const parsed = parseOverlayHash(hash);
  if (parsed === null) return;
  if (formatOverlayParam(parsed) !== formatOverlayParam(chosenOverlays.peek())) {
    chosenOverlays.value = parsed;
  }
  applyStaticSourcesFromLink(parseStaticSourcesHash(hash) === true);
  applyProtectedSitesFromLink(parseProtectedSitesHash(hash) === true);
}

/**
 * Start mirroring the overlay choice into the fragment, after applying the fragment the
 * page opened with — the same shape as `startFilterUrlSync`. Returns the stop function.
 */
export function startOverlayUrlSync(
  loc: FragmentLocation = location,
  hist: FragmentHistory = history,
  events: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  applyOverlayHash(loc.hash);
  const onHashChange = (): void => {
    applyOverlayHash(loc.hash);
  };
  events.addEventListener('hashchange', onHashChange);
  const stopEffect = effect(() => {
    const members = overlayHashMembers(
      chosenOverlays.value,
      staticSourcesChosen.value,
      protectedSitesChosen.value,
    );
    replaceHash(loc, hist, withFragmentMembers(loc.hash, members));
  });
  return () => {
    events.removeEventListener('hashchange', onHashChange);
    stopEffect();
  };
}
