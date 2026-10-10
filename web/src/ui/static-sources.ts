/**
 * The static hot-source mask in the browser (TASKS F16; 11-data-science §3.6): solar parks,
 * thermal power plants, gas flares and heavy industry mapped in OpenStreetMap — places a
 * satellite sees as a hotspot whether or not anything is burning.
 *
 * Two readers use it:
 * - the event detail, which says "near a known solar park / industrial heat source — may
 *   not be a fire": per detection once the detections file has loaded ("2 of 5 detections
 *   are near …"), and from the event's centre until then or when there is no such file —
 *   both within {@link STATIC_SOURCE_CAVEAT} of a source;
 * - the Layers panel, which can draw the mask on the map so the reader sees why.
 *
 * The event page also follows the server's `static_source_verdict`: when the server says
 * `annotated` and the bundled mask finds nothing, a kind-neutral sentence still appears
 * ({@link eventStaticSourceCaveat} has the rule).
 *
 * The caveat never hides anything: the event, its score and its detections are shown
 * exactly as before, with one more sentence. The server applies the separate, stricter
 * §3.6 override (every member on a source) when it scores; the web does not re-derive it.
 *
 * The asset (~84 KiB gzip) is a build file served from our own origin, fetched the first
 * time either reader needs it — never at boot. Same shape as `place-search-data.ts`: an
 * idempotent load, a state signal, a retry after a failure.
 *
 * The layer choice is persisted (`fw:static-sources`), like the EFFIS overlays: drawing it
 * costs nothing metered.
 */

import { computed, signal } from '@preact/signals';
import {
  CREDITS,
  EMPTY_STATIC_SOURCE_MASK,
  STATIC_SOURCE_CAVEAT,
  STATIC_SOURCE_METRIC,
  nearestStaticSource,
  parseStaticSourceMask,
  type Credit,
  type StaticSourceKind,
  type StaticSourceMask,
} from '@fire-watch/contracts';

import staticSourcesUrl from '../assets/geodata/static-sources.json?url';
import type { StaticSourceVerdictOnWire } from '../core/types.js';
import { readStorage, writeStorage } from './storage.js';

export const STATIC_SOURCES_STORAGE_KEY = 'fw:static-sources';

export type StaticSourcesState = 'idle' | 'loading' | 'ready' | 'failed';
export const staticSourcesState = signal<StaticSourcesState>('idle');
/** Empty until loaded; an empty mask produces no caveat and draws nothing. */
export const staticSourceMask = signal<StaticSourceMask>(EMPTY_STATIC_SOURCE_MASK);

let load: Promise<void> | null = null;

/** Idempotent while a load is in flight or done; a failed load may be retried. */
export function loadStaticSources(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (load !== null) return load;
  staticSourcesState.value = 'loading';
  load = fetchImpl(staticSourcesUrl)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      staticSourceMask.value = parseStaticSourceMask((await response.json()) as unknown);
      staticSourcesState.value = 'ready';
    })
    .catch(() => {
      staticSourcesState.value = 'failed';
      load = null;
    });
  return load;
}

// ── The Layers-panel choice ─────────────────────────────────────────────────

export const staticSourcesChosen = signal(readStorage(STATIC_SOURCES_STORAGE_KEY) === 'on');

export function setStaticSourcesChosen(on: boolean): void {
  staticSourcesChosen.value = on;
  writeStorage(STATIC_SOURCES_STORAGE_KEY, on ? 'on' : 'off');
  if (on) void loadStaticSources();
}

/**
 * Apply the choice a link states (`ov=…,static`, `url-state.ts`). Unlike
 * {@link setStaticSourcesChosen} it never writes storage — someone else's link must not
 * overwrite the reader's own `fw:static-sources`, the same rule the other overlays follow.
 */
export function applyStaticSourcesFromLink(on: boolean): void {
  if (staticSourcesChosen.peek() !== on) staticSourcesChosen.value = on;
  if (on) void loadStaticSources();
}

/** What the map draws: the mask while the layer is on and loaded, otherwise nothing. */
export const staticSourcesDraw = computed<StaticSourceMask | null>(() =>
  staticSourcesChosen.value && staticSourcesState.value === 'ready' ? staticSourceMask.value : null,
);

// ── The event-detail caveat ─────────────────────────────────────────────────

/** Which sentence the caveat uses: solar parks read differently from everything else. */
export type StaticSourceCaveat = 'solar' | 'industrial';

export function caveatFor(kind: StaticSourceKind): StaticSourceCaveat {
  return kind === 'solar' ? 'solar' : 'industrial';
}

/**
 * The caveat for a point (an event's approximate centre), or `null` when no known source
 * is within `STATIC_SOURCE_CAVEAT.radiusM` — including while the mask is not loaded.
 */
export function staticSourceCaveat(
  mask: StaticSourceMask,
  point: { readonly lon: number; readonly lat: number },
): StaticSourceCaveat | null {
  const hit = nearestStaticSource(
    mask,
    { lon: point.lon, lat: point.lat },
    STATIC_SOURCE_CAVEAT.radiusM,
    STATIC_SOURCE_METRIC,
  );
  return hit === null ? null : caveatFor(hit.source.kind);
}

/** The per-detection caveat: how many of the event's detections sit near a known source. */
export interface StaticSourceDetectionCaveat {
  /** `solar` only when every detection near a source is nearest a solar park. */
  readonly caveat: StaticSourceCaveat;
  readonly near: number;
  readonly total: number;
}

/**
 * The caveat per detection (TASKS F16): an event's centre can sit clear of a solar park
 * while some of its pixels lie on one — or the other way round — so once the detections
 * file has loaded the caveat is decided pixel by pixel, with the same radius as the centre
 * caveat. `null` when no detection is near a source, when there are no positions, and
 * while the mask is not loaded. It says how many, never which: the page does not list
 * pixels, and the count is what tells the reader how much of the event to doubt.
 */
export function staticSourceDetectionCaveat(
  mask: StaticSourceMask,
  positions: readonly { readonly lon: number; readonly lat: number }[],
): StaticSourceDetectionCaveat | null {
  let near = 0;
  let allSolar = true;
  for (const position of positions) {
    const caveat = staticSourceCaveat(mask, position);
    if (caveat === null) continue;
    near += 1;
    if (caveat !== 'solar') allSolar = false;
  }
  if (near === 0) return null;
  return { caveat: allSolar ? 'solar' : 'industrial', near, total: positions.length };
}

// ── Following the server's verdict ──────────────────────────────────────────

/**
 * What the event page's caveat says (TASKS F16): a kind-specific sentence from the bundled
 * mask — per detection, or from the centre — or the kind-neutral "server check" sentence.
 */
export type EventStaticSourceCaveat =
  | ({ readonly basis: 'detections' } & StaticSourceDetectionCaveat)
  | { readonly basis: 'centre'; readonly caveat: StaticSourceCaveat }
  | { readonly basis: 'server' };

/** The bundled mask's own answer, before the server's verdict is weighed. */
export type BundledStaticSourceLookup = Exclude<EventStaticSourceCaveat, { basis: 'server' }>;

/**
 * Combine the server's `static_source_verdict` with the bundled mask's lookup. The rule is
 * "never hide information the reader already sees", so the verdict can only add a caveat:
 *
 * - The bundled mask found a source → its kind-specific sentence, whatever the verdict. The
 *   reader can switch the mask layer on and see that source beside the event, so a server
 *   `clear` (an older server mask, or the server's tighter §3.6 distance) never takes the
 *   sentence away.
 * - The bundled mask found nothing and the server says `annotated` → the kind-neutral
 *   sentence. The server's mask is hot-reloaded and can be newer than the bundle (version
 *   skew), and the wire carries no kind, so the page cannot say "solar park" or
 *   "industrial". This also covers the bundle still loading, or failing to load.
 * - The bundled mask found nothing and the verdict is `clear` or not reported → nothing,
 *   exactly as before: the absence of a caveat is never a claim that the hotspot is a fire.
 *
 * The caller passes whichever bundled lookup it trusts — per detection once positions are
 * known, the centre until then ({@link bundledStaticSourceLookup}); the two are not mixed.
 */
export function eventStaticSourceCaveat(
  verdict: StaticSourceVerdictOnWire | undefined,
  bundled: BundledStaticSourceLookup | null,
): EventStaticSourceCaveat | null {
  if (bundled !== null) return bundled;
  return verdict === 'annotated' ? { basis: 'server' } : null;
}

/**
 * The bundled lookup for an event: per detection when positions are known (an empty list
 * counts as unknown), otherwise from the event's centre; `null` when nothing is near.
 */
export function bundledStaticSourceLookup(
  mask: StaticSourceMask,
  centre: { readonly lon: number; readonly lat: number },
  positions: readonly { readonly lon: number; readonly lat: number }[] | null,
): BundledStaticSourceLookup | null {
  if (positions !== null && positions.length > 0) {
    const perDetection = staticSourceDetectionCaveat(mask, positions);
    return perDetection === null ? null : { basis: 'detections', ...perDetection };
  }
  const caveat = staticSourceCaveat(mask, centre);
  return caveat === null ? null : { basis: 'centre', caveat };
}

/** The OSM credit the mask is paid for with (contracts registry, `osm`), never retyped. */
export function staticSourcesCredit(): Pick<Credit, 'text' | 'href'> | null {
  return CREDITS.find((entry) => entry.id === 'osm') ?? null;
}

export function resetStaticSourcesForTest(): void {
  load = null;
  staticSourcesState.value = 'idle';
  staticSourceMask.value = EMPTY_STATIC_SOURCE_MASK;
  staticSourcesChosen.value = false;
}
