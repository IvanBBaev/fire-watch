/**
 * The Layers panel's state (TASKS G4): which EFFIS context overlays the reader chose, what
 * the server's proxy copies say about themselves, and the payload the map draws.
 *
 * The choice is persisted (`fw:layers`): an overlay spends nothing metered — the proxy
 * serves one cached file to everyone — so a reader who wants the fire-danger layer on
 * should not have to ask again every visit. Imagery is the opposite case and stays
 * per-session (`ui/imagery.ts`).
 *
 * The browser only ever fetches the proxy's paths (ADR-001 A1.2), without a query string
 * (the proxy refuses one), and only for an overlay the reader switched on — so a build
 * without a server (fixtures, e2e) never asks for either while the overlays are off, and
 * shows them as unavailable when a reader switches one on.
 *
 * {@link parseOverlayParam} / {@link formatOverlayParam} / {@link setOverlays} are the
 * typed seam for putting the choice in the URL fragment; this module does not touch it.
 */

import { computed, effect, signal } from '@preact/signals';
import { CREDITS, ecmwfComponents, renderCredit } from '@fire-watch/contracts';

import type { Messages } from '../core/i18n/messages.js';
import type { Clock } from '../core/ports.js';
import { parseLightningOverlay, type LightningOverlayBody } from '../core/lightning.js';
import { parsePassSwaths, type PassSwathsDoc } from '../core/pass-swaths.js';
import { parseWindOverlay, type WindOverlayBody } from '../core/wind.js';
import { creditRenderContext } from './logic/credits.js';
import { readStorage, writeStorage } from './storage.js';

export type OverlayId = 'fwi' | 'ba' | 'wind' | 'swaths' | 'lightning';

/** Canonical order: the order the panel lists them and the URL spells them. */
export const OVERLAY_IDS: readonly OverlayId[] = ['fwi', 'ba', 'wind', 'swaths', 'lightning'];

/** The EFFIS overlays; `wind` (F14, ECMWF) and `swaths` (F15, CelesTrak) are not EFFIS's. */
export const EFFIS_OVERLAY_IDS: readonly OverlayId[] = ['fwi', 'ba'];

export const LAYERS_STORAGE_KEY = 'fw:layers';
export const LAYERS_PANEL_STORAGE_KEY = 'fw:layers-panel';

/** The proxy's paths — same origin, like `/api`; never an EFFIS or ECMWF URL. */
export const OVERLAY_URLS: Readonly<Record<OverlayId, string>> = {
  fwi: '/overlays/effis/fwi.png',
  ba: '/overlays/effis/ba.json',
  wind: '/overlays/wind/latest.json',
  swaths: '/overlays/passes/swaths.json',
  lightning: '/overlays/lightning/recent.json',
};

/**
 * A copy older than this is re-fetched when the overlay is switched on again. The proxy's
 * own edge TTL is ten minutes, so asking sooner would only return the same bytes.
 */
export const OVERLAY_REFETCH_AFTER_MS = 15 * 60 * 1000;

/**
 * The FWI legend: EFFIS's own six danger classes for `mf010.fwi`, with the colours its
 * PNG paints them in (read off the live layer legend, 2026-09-28). The legend repeats the
 * provider's palette on purpose — a recoloured legend would describe a raster we do not
 * draw. `upper` is the class's exclusive FWI ceiling; `null` for the open top class.
 */
export const FWI_CLASSES = [
  { color: '#9cffc0', upper: 11.2 },
  { color: '#cde24e', upper: 21.3 },
  { color: '#e6ac00', upper: 38.0 },
  { color: '#d97010', upper: 50.0 },
  { color: '#ad060e', upper: 70.0 },
  { color: '#3a0015', upper: null },
] as const;

/**
 * The FWI forecast day the reader picked (V2-B1): 0 is today's EFFIS index, 1 … 9 the
 * days ahead from the GWIS `ecmwf.fwi` forecast, relayed by the proxy as published. The
 * proxy serves one allow-listed file per day; the browser never names a date.
 */
export const FWI_FORECAST_DAYS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type FwiForecastDay = (typeof FWI_FORECAST_DAYS)[number];

/** The proxy path for a forecast day: today's file, or `fwi-d<n>.png` for a day ahead. */
export function fwiOverlayUrl(day: FwiForecastDay): string {
  return day === 0 ? OVERLAY_URLS.fwi : `/overlays/effis/fwi-d${String(day)}.png`;
}

/**
 * The UTC date (`YYYY-MM-DD`) a forecast day should be for, counted from `todayIso`'s UTC
 * date — the date the proxy's `valid_for` names when its copy is up to date.
 */
export function expectedFwiDate(todayIso: string, day: FwiForecastDay): string | null {
  const start = Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start)) return null;
  return new Date(start + day * 86_400_000).toISOString().slice(0, 10);
}

// ── URL seam ────────────────────────────────────────────────────────────────

/**
 * `fwi,ba` → the overlays it names, in canonical order. Unknown and repeated tokens are
 * dropped, so a link from a newer build still opens; `null` (no parameter) stays `null`,
 * which is not the same as `''` (explicitly none).
 */
export function parseOverlayParam(raw: string | null): readonly OverlayId[] | null {
  if (raw === null) return null;
  const tokens = new Set(raw.split(',').map((token) => token.trim()));
  return OVERLAY_IDS.filter((id) => tokens.has(id));
}

/** The canonical spelling of a choice; `''` for none. */
export function formatOverlayParam(ids: readonly OverlayId[]): string {
  return OVERLAY_IDS.filter((id) => ids.includes(id)).join(',');
}

/**
 * The `ov=` token for the static hot-source mask (TASKS F16). It is not an
 * {@link OverlayId}: the mask is a build asset with no proxy copy, status or refetch, and
 * its choice lives in `static-sources.ts` (`fw:static-sources`). It shares the member so a
 * copied link carries every layer the reader had on; {@link parseOverlayParam} ignores it.
 */
export const STATIC_SOURCES_OVERLAY_TOKEN = 'static';

/** What an `ov=` value says about the mask; `null` (no parameter) stays `null`. */
export function parseStaticSourcesParam(raw: string | null): boolean | null {
  if (raw === null) return null;
  return raw.split(',').some((token) => token.trim() === STATIC_SOURCES_OVERLAY_TOKEN);
}

/** The whole `ov=` value: the overlays in canonical order, then the mask; `''` for none. */
export function formatLayersParam(ids: readonly OverlayId[], staticSources: boolean): string {
  const overlays = formatOverlayParam(ids);
  if (!staticSources) return overlays;
  return overlays === ''
    ? STATIC_SOURCES_OVERLAY_TOKEN
    : `${overlays},${STATIC_SOURCES_OVERLAY_TOKEN}`;
}

// ── The choice ──────────────────────────────────────────────────────────────

export const chosenOverlays = signal<readonly OverlayId[]>(
  parseOverlayParam(readStorage(LAYERS_STORAGE_KEY)) ?? [],
);

/** Replace the choice (canonicalised) and remember it. */
export function setOverlays(ids: readonly OverlayId[]): void {
  const next = parseOverlayParam(formatOverlayParam(ids)) ?? [];
  if (formatOverlayParam(next) !== formatOverlayParam(chosenOverlays.peek())) {
    chosenOverlays.value = next;
  }
  writeStorage(LAYERS_STORAGE_KEY, formatOverlayParam(next));
}

export function toggleOverlay(id: OverlayId): void {
  const current = chosenOverlays.peek();
  setOverlays(current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
}

/** Any EFFIS overlay chosen — the credits page then owes the EFFIS credit (`layer:effis`). */
export const effisChosen = computed(() =>
  chosenOverlays.value.some((id) => EFFIS_OVERLAY_IDS.includes(id)),
);

/** Wind chosen — the credits page then owes the five ECMWF components (`derived:ecmwf`). */
export const windChosen = computed(() => chosenOverlays.value.includes('wind'));

/** Swaths chosen (F15) — the panel then prints the CelesTrak credit, the map corner too. */
export const swathsChosen = computed(() => chosenOverlays.value.includes('swaths'));

/** Lightning chosen (F18) — the panel then prints the EUMETSAT credit, the map corner too. */
export const lightningChosen = computed(() => chosenOverlays.value.includes('lightning'));

/**
 * The forecast day on screen. Per session, never persisted: a remembered "+3" would be a
 * different date on the next visit, and the reader who comes back expects today's index.
 */
export const fwiDay = signal<FwiForecastDay>(0);

/** A forecast copy is GWIS's — the credits page then owes the GWIS credit (`layer:gwis`). */
export const gwisChosen = computed(() => chosenOverlays.value.includes('fwi') && fwiDay.value > 0);

/**
 * A raster of the day the reader left: dropped from the map at once, its object URL
 * revoked the next time the loader runs (the loader owns the revoke seam).
 */
let orphanedFwiUrl: string | null = null;

/** Pick a forecast day. The previous day's raster leaves the map; the sync loads the new one. */
export function setFwiDay(day: FwiForecastDay): void {
  if (day === fwiDay.peek()) return;
  const held = payloads.peek().fwi;
  if (held !== null) orphanedFwiUrl = held;
  payloads.value = { ...payloads.peek(), fwi: null };
  setStatus('fwi', IDLE);
  fwiDay.value = day;
}

/** The GWIS credit, rendered from the contracts registry exactly as `/credits` renders it. */
export function gwisCreditText(
  clock: Pick<Clock, 'epochNow'>,
  messages: Pick<Messages, 'appTitle'>,
): string {
  const credit = CREDITS.find((entry) => entry.id === 'gwis');
  return credit === undefined ? '' : renderCredit(credit, creditRenderContext(clock, messages));
}

/**
 * The five ECMWF components, rendered from the contracts registry. The Terms owe them
 * together, so the panel prints all five or none — never a partial credit.
 */
export function ecmwfCreditTexts(
  clock: Pick<Clock, 'epochNow'>,
  messages: Pick<Messages, 'appTitle'>,
): readonly string[] {
  const context = creditRenderContext(clock, messages);
  return ecmwfComponents().map((credit) => renderCredit(credit, context));
}

/**
 * The EFFIS credit, rendered from the contracts registry exactly as `/credits` renders it
 * — the panel prints it beside the overlays and the burnt-area source carries it into the
 * map corner. Never retyped here.
 */
export function effisCreditText(
  clock: Pick<Clock, 'epochNow'>,
  messages: Pick<Messages, 'appTitle'>,
): string {
  const credit = CREDITS.find((entry) => entry.id === 'effis');
  return credit === undefined ? '' : renderCredit(credit, creditRenderContext(clock, messages));
}

// ── The panel's disclosure ──────────────────────────────────────────────────

export const layersPanelOpen = signal(readStorage(LAYERS_PANEL_STORAGE_KEY) === 'open');

export function setLayersPanelOpen(open: boolean): void {
  layersPanelOpen.value = open;
  writeStorage(LAYERS_PANEL_STORAGE_KEY, open ? 'open' : 'closed');
}

// ── What the proxy said ─────────────────────────────────────────────────────

export type OverlayStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  /** No copy to show: no server, the proxy has none yet (503), or a body we cannot use. */
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      /** `suspect`: the A2.2 pass-through — shown, but flagged. */
      readonly state: 'current' | 'suspect';
      /** When EFFIS made this copy available — the proxy's recorded instant, never ours. */
      readonly availableAt: string;
      /** The UTC date a daily layer is *for* (FWI); `null` for a "latest" layer. */
      readonly validFor: string | null;
      /** The forecast step's valid instant (wind, F14); absent for the EFFIS layers. */
      readonly validAt?: string;
      /**
       * How soon after it arrived a copy whose `validAt` has passed is asked for again;
       * absent means `overlay-refresh.ts`'s default. Lightning (F18) sets its own.
       */
      readonly retryAfterMs?: number;
      /** Our monotonic clock when the copy arrived — only for deciding when to re-fetch. */
      readonly fetchedAtMs: number;
    };

const IDLE: OverlayStatus = { kind: 'idle' };

export const overlayStatus = signal<Readonly<Record<OverlayId, OverlayStatus>>>({
  fwi: IDLE,
  ba: IDLE,
  wind: IDLE,
  swaths: IDLE,
  lightning: IDLE,
});

const payloads = signal<{
  readonly fwi: string | null;
  readonly ba: object | null;
  readonly wind: WindOverlayBody | null;
  readonly swaths: PassSwathsDoc | null;
  readonly lightning: LightningOverlayBody | null;
}>({
  fwi: null,
  ba: null,
  wind: null,
  swaths: null,
  lightning: null,
});

/** What the map draws: a chosen overlay with a usable copy, nothing else. */
export const effisOverlayPayload = computed(() => {
  const chosen = chosenOverlays.value;
  const { fwi, ba } = payloads.value;
  return {
    fwiImageUrl: chosen.includes('fwi') ? fwi : null,
    burntAreas: chosen.includes('ba') ? ba : null,
  };
});

/** The wind forecast step the map draws, or `null` (F14). */
export const windOverlayPayload = computed(() =>
  chosenOverlays.value.includes('wind') ? payloads.value.wind : null,
);

/** The satellite swath document the map draws from, or `null` (F15). */
export const passSwathsPayload = computed(() =>
  chosenOverlays.value.includes('swaths') ? payloads.value.swaths : null,
);

/** The recent-flashes body the map draws from, or `null` (F18). */
export const lightningOverlayPayload = computed(() =>
  chosenOverlays.value.includes('lightning') ? payloads.value.lightning : null,
);

/** The browser seams the loader uses; swapped in tests. */
export interface OverlayLoaderDeps {
  readonly fetch: (url: string) => Promise<Response>;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly now: () => number;
  /** Per-overlay URL overrides — the fixtures build points `wind` at a committed file. */
  readonly urls?: Readonly<Partial<Record<OverlayId, string>>> | undefined;
}

/** The real browser seams; `now` is monotonic — it only ever measures a copy's age. */
export const browserOverlayLoader = (
  clock: Pick<Clock, 'monotonicNow'>,
  urls?: Readonly<Partial<Record<OverlayId, string>>>,
): OverlayLoaderDeps => ({
  fetch: (url) => fetch(url, { credentials: 'omit' }),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => {
    URL.revokeObjectURL(url);
  },
  now: () => clock.monotonicNow(),
  urls,
});

function setStatus(id: OverlayId, status: OverlayStatus): void {
  overlayStatus.value = { ...overlayStatus.peek(), [id]: status };
}

function headerDate(response: Response, name: string): string | null {
  const value = response.headers.get(name);
  return value !== null && Number.isFinite(Date.parse(value)) ? value : null;
}

function isFeatureCollection(value: unknown): value is { type: 'FeatureCollection' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'FeatureCollection' &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

/** Fetch one overlay's proxy copy; every failure ends as `unavailable`, never a throw. */
export async function loadOverlay(id: OverlayId, deps: OverlayLoaderDeps): Promise<void> {
  setStatus(id, { kind: 'loading' });
  if (id === 'wind') {
    await loadWind(deps);
    return;
  }
  if (id === 'swaths') {
    await loadSwaths(deps);
    return;
  }
  if (id === 'lightning') {
    await loadLightning(deps);
    return;
  }
  const day = fwiDay.peek();
  if (id === 'fwi' && orphanedFwiUrl !== null) {
    deps.revokeObjectURL(orphanedFwiUrl);
    orphanedFwiUrl = null;
  }
  try {
    const response = await deps.fetch(id === 'fwi' ? fwiOverlayUrl(day) : OVERLAY_URLS[id]);
    // The reader picked another day while this one was in flight: its load owns the status.
    if (id === 'fwi' && fwiDay.peek() !== day) return;
    const availableAt = headerDate(response, 'x-fire-watch-overlay-available-at');
    const state = response.headers.get('x-fire-watch-overlay-state');
    if (!response.ok || availableAt === null || (state !== 'current' && state !== 'suspect')) {
      setStatus(id, { kind: 'unavailable' });
      return;
    }
    const validFor = response.headers.get('x-fire-watch-overlay-valid-for');
    if (id === 'fwi') {
      const blob = await response.blob();
      if (fwiDay.peek() !== day) return;
      const url = deps.createObjectURL(blob);
      const previous = payloads.peek().fwi;
      payloads.value = { ...payloads.peek(), fwi: url };
      if (previous !== null) deps.revokeObjectURL(previous);
    } else {
      const body: unknown = await response.json();
      if (!isFeatureCollection(body)) {
        setStatus(id, { kind: 'unavailable' });
        return;
      }
      payloads.value = { ...payloads.peek(), ba: body };
    }
    setStatus(id, {
      kind: 'ready',
      state,
      availableAt,
      validFor: validFor !== null && /^\d{4}-\d{2}-\d{2}$/u.test(validFor) ? validFor : null,
      fetchedAtMs: deps.now(),
    });
  } catch {
    if (id !== 'fwi' || fwiDay.peek() === day) setStatus(id, { kind: 'unavailable' });
  }
}

/**
 * The wind body carries its own times (`run_at`, `valid_at`, `available_at`), so they are
 * read from the body, never from headers or the fetch: a revalidated or fixture copy then
 * cannot relabel itself. Every failure ends as `unavailable`, never a throw.
 */
async function loadWind(deps: OverlayLoaderDeps): Promise<void> {
  try {
    const response = await deps.fetch(deps.urls?.wind ?? OVERLAY_URLS.wind);
    const body = response.ok ? parseWindOverlay(await response.json()) : null;
    if (body === null) {
      setStatus('wind', { kind: 'unavailable' });
      return;
    }
    payloads.value = { ...payloads.peek(), wind: body };
    setStatus('wind', {
      kind: 'ready',
      state: 'current',
      availableAt: body.available_at,
      validFor: null,
      // The step the proxy chose as nearest now; `overlay-refresh.ts` asks again once it passes.
      validAt: body.valid_at,
      fetchedAtMs: deps.now(),
    });
  } catch {
    setStatus('wind', { kind: 'unavailable' });
  }
}

/**
 * The swath document dates itself (`computed_for`), like the wind body: a fixture or a
 * revalidated copy cannot relabel itself. `validAt` is the instant it was computed for, so
 * `overlay-refresh.ts` asks for a newer copy every half hour after it — the server
 * recomputes every 10 minutes, and recent/next is re-decided on the reader's clock in
 * between (`core/pass-swaths.ts`). Every failure ends as `unavailable`, never a throw.
 */
async function loadSwaths(deps: OverlayLoaderDeps): Promise<void> {
  try {
    const response = await deps.fetch(deps.urls?.swaths ?? OVERLAY_URLS.swaths);
    const body = response.ok ? parsePassSwaths(await response.json()) : null;
    if (body === null) {
      setStatus('swaths', { kind: 'unavailable' });
      return;
    }
    payloads.value = { ...payloads.peek(), swaths: body };
    setStatus('swaths', {
      kind: 'ready',
      state: 'current',
      availableAt: body.computed_for,
      validFor: null,
      validAt: body.computed_for,
      fetchedAtMs: deps.now(),
    });
  } catch {
    setStatus('swaths', { kind: 'unavailable' });
  }
}

/**
 * How soon a lightning copy is asked for again. Products arrive every 10 minutes and the
 * proxy's `max-age` is 60 s, so five minutes keeps the newest flashes at most one product
 * behind without polling harder than the worker refreshes.
 */
export const LIGHTNING_RETRY_MS = 5 * 60 * 1000;

/**
 * The lightning body dates itself (`covered_through`, the end of the newest product merged),
 * like the wind body: a fixture or a revalidated copy cannot relabel itself. `validAt` is
 * that instant, already past, so `overlay-refresh.ts` asks again {@link LIGHTNING_RETRY_MS}
 * after each copy arrives. Every failure — including the proxy's 503 for a stopped
 * pipeline — ends as `unavailable`, never a throw.
 */
async function loadLightning(deps: OverlayLoaderDeps): Promise<void> {
  try {
    const response = await deps.fetch(deps.urls?.lightning ?? OVERLAY_URLS.lightning);
    const body = response.ok ? parseLightningOverlay(await response.json()) : null;
    if (body === null) {
      // Unlike wind, the held copy is dropped: the proxy's 503 means the pipeline stopped,
      // and flashes it last saw must not stay on the map beside an "unavailable" panel.
      payloads.value = { ...payloads.peek(), lightning: null };
      setStatus('lightning', { kind: 'unavailable' });
      return;
    }
    payloads.value = { ...payloads.peek(), lightning: body };
    setStatus('lightning', {
      kind: 'ready',
      state: 'current',
      availableAt: body.available_at,
      validFor: null,
      validAt: body.covered_through,
      retryAfterMs: LIGHTNING_RETRY_MS,
      fetchedAtMs: deps.now(),
    });
  } catch {
    payloads.value = { ...payloads.peek(), lightning: null };
    setStatus('lightning', { kind: 'unavailable' });
  }
}

/**
 * Keep every chosen overlay loaded: fetch it when it is switched on and has no copy (or an
 * old one). Returns the disposer. The map pane runs it for the page's lifetime.
 */
export function startOverlaySync(deps: OverlayLoaderDeps): () => void {
  return effect(() => {
    // A new forecast day resets the FWI status to idle, so reading it here reloads.
    void fwiDay.value;
    for (const id of chosenOverlays.value) {
      const status = overlayStatus.peek()[id];
      if (status.kind === 'loading') continue;
      if (status.kind === 'ready' && deps.now() - status.fetchedAtMs < OVERLAY_REFETCH_AFTER_MS) {
        continue;
      }
      void loadOverlay(id, deps);
    }
  });
}

/** Test seam: forget every copy and status. */
export function resetOverlaysForTest(): void {
  chosenOverlays.value = [];
  overlayStatus.value = { fwi: IDLE, ba: IDLE, wind: IDLE, swaths: IDLE, lightning: IDLE };
  payloads.value = { fwi: null, ba: null, wind: null, swaths: null, lightning: null };
  layersPanelOpen.value = false;
  fwiDay.value = 0;
  orphanedFwiUrl = null;
}
