/**
 * CI-13 — attribution presence, web half (ADR-001 A1.4, TASKS G5).
 *
 * **What is walked.** Nothing here is a hand-kept list of credits. For every surface the
 * registry assigns to the web ({@link CREDIT_SURFACE_OWNER}), every credit context the
 * registry can name ({@link CreditCondition}) and both locales, the surface is produced
 * through its real code path and the registry is asked what that output owes:
 * - `credits-page` and `about`: the page components are server-rendered with preact-iso's
 *   `prerender` inside the real {@link AppContext}, so the list is whatever the component
 *   actually emits for that config — including a condition the component forgets to pass;
 * - `map-corner`: {@link createMapController} runs against a recording `maplibre-gl`, fed
 *   by {@link mapCornerAttribution} (the call the map pane makes), and the attribution
 *   control it *adds to the map* is read back.
 * A context is reached through configuration ({@link activeCreditConditions}), never by
 * injecting the condition list; a condition no shipped configuration can produce is listed
 * as unreachable with the reason, and the test fails the day a configuration reaches it.
 *
 * **Style combinations (TASKS G3/G5/G6).** What the map draws is a combination: an
 * external basemap URL or the self-hosted outdoor style (a half-deployed outdoor config
 * falls back to the external one), the outdoor style's Terrarium hillshade when a DEM
 * mirror is configured, and the reader's imagery toggle. {@link COMBINATIONS} is every
 * such combination, and every surface is walked under each one with the conditions
 * `activeCreditConditions` derives for it. A separate case reads back what the controller
 * actually drew — the style it loaded in each theme, that style's sources, the imagery
 * source — and holds the derived conditions to it, so the credits cannot describe a
 * different basemap from the one on screen.
 *
 * **Compiler-total.** {@link PROBES} is `satisfies Record<CreditSurfacesOf<'web'>, …>` and
 * {@link CONTEXTS} is `satisfies Record<CreditCondition, …>`: a new web surface or a new
 * condition in the registry does not compile until it has a probe or a stated reason.
 *
 * **What fails.** An owed credit (required, verified, not plugin-injected) whose asserted
 * wording is not in the surface's visible text, or whose licence link is not among its
 * links. Gaps are compared as an exact register ({@link KNOWN_FINDINGS}), so a new gap and a
 * silently closed one both go red. The known ones are licence findings awaiting a founder
 * decision on corner copy — they are recorded, not papered over.
 *
 * **Esri imagery (TASKS G6).** `toggle:esri` is reached through the reader's toggle
 * (`activeCreditConditions(config, { imageryOn })`), not configuration. Its credit is
 * `pluginInjected`, so `attributionGaps` does not assert it; a dedicated case below asserts
 * that the map corner carries it exactly while imagery is drawn, read off the raster
 * source's `attribution` the controller adds (which MapLibre's control displays).
 *
 * **EFFIS overlays (TASKS G4).** `layer:effis` is reached the same way — the reader's
 * choice in the Layers panel (`effis-on`), not configuration. The credits page reads that
 * choice from `ui/layers.ts`, so its probe sets it; the map corner draws both overlays and
 * `drawnConditions` recognises them by their `effis-` source ids.
 *
 * **Wind (TASKS F14).** `derived:ecmwf` likewise (`wind-on`): the five ECMWF credits are
 * owed on the credits page only, and the map corner's drawn set recognises the arrows by
 * their source id.
 *
 * **Before/after imagery (V2-E2).** `layer:gibs` is reached by the reader opening the
 * comparison on an event page (`gibs-on`). The `imagery-compare` probe renders the real
 * panel then and nothing otherwise — the panel, and its credit, exist only while open. The
 * comparison is a panel beside the map, not a map layer, so the map corner's drawn set
 * never contains it.
 *
 * **What this does not see.** Styling: a credit that is present but hidden, clipped or
 * collapsed (the corner control is `compact`) passes. Credits MapLibre takes from the
 * external basemap style's own `attribution` fields.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'preact';
import prerender from 'preact-iso/prerender';

import {
  CREDIT_SURFACE_OWNER,
  CREDITS,
  assertableCredits,
  attributionGaps,
} from '@fire-watch/contracts';
import type {
  CreditCondition,
  CreditSurface,
  CreditSurfacesOf,
  RenderContext,
  RenderedAttribution,
} from '@fire-watch/contracts';

import type { ClientConfig } from '../core/config.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import type { LightningDraw } from '../core/lightning.js';
import type { PassSwathsDraw } from '../core/pass-swaths.js';
import type { Clock } from '../core/ports.js';
import type { FireEventStore, Locale, OutdoorBasemapConfig, ThemeName } from '../core/types.js';
import type { WindOverlayBody } from '../core/wind.js';
import { createMapController } from '../map/map-controller.js';
import { WIND_SOURCE_ID } from '../map/wind-layer.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import type { CreditSessionState } from './logic/credits.js';
import { activeCreditConditions, mapCornerAttribution } from './logic/credits.js';
import { effisCreditText, setFwiDay, setOverlays } from './layers.js';
import { eumetsatCreditText } from './lightning.js';
import { celestrakCredit } from './passes.js';
import { BeforeAfter } from './event/before-after.js';
import { AboutPage } from './pages/about.js';
import { CreditsPage } from './pages/credits.js';

const recorded = vi.hoisted(() => ({
  styles: [] as unknown[],
  controls: [] as unknown[],
  sources: new Map<string, unknown>(),
  layers: new Set<string>(),
}));

// The controller is the only module that touches a live map; this stands in for the
// library so the control and the sources it adds can be read back. Nothing else of the
// map is exercised.
vi.mock('maplibre-gl', () => ({
  Map: class {
    constructor(options: { readonly style?: unknown }) {
      recorded.styles.push(options.style);
    }
    addControl(control: unknown): void {
      recorded.controls.push(control);
    }
    on(): void {}
    once(): void {}
    getSource(id: string): unknown {
      return recorded.sources.get(id);
    }
    addSource(id: string, source: unknown): void {
      recorded.sources.set(id, source);
    }
    removeSource(id: string): void {
      recorded.sources.delete(id);
    }
    getLayer(id: string): unknown {
      return recorded.layers.has(id) ? { id } : undefined;
    }
    addLayer(layer: { readonly id: string }): void {
      recorded.layers.add(layer.id);
    }
    removeLayer(id: string): void {
      recorded.layers.delete(id);
    }
    hasImage(): boolean {
      return true;
    }
    addImage(): void {}
  },
  AttributionControl: class {
    constructor(readonly options: { readonly customAttribution?: string | string[] }) {}
  },
  // The controller points MapLibre at the bundled worker when its module loads.
  setWorkerUrl: (): void => {},
}));

const NOW = Date.UTC(2026, 8, 23, 12);

/** A one-cell wind body: what reaches the controller decides the credit, not the data. */
const WIND_BODY: WindOverlayBody = {
  schema_version: 1,
  provider: 'ecmwf-open-data',
  model: 'ifs',
  run_at: '2026-09-23T00:00:00Z',
  step_hours: 12,
  valid_at: '2026-09-23T12:00:00Z',
  available_at: '2026-09-23T07:40:00Z',
  grid: {
    west: 25,
    south: 42,
    east: 25,
    north: 42,
    resolution_deg: 0.5,
    cols: 1,
    rows: 1,
    order: 'north_to_south_west_to_east',
  },
  speed_ms: [4],
  direction_from_deg: [300],
  wind_overlay_version: 'wind_overlay_v1',
};
const CATALOGS = { bg, en } as const satisfies Record<Locale, Messages>;
const LOCALES = Object.keys(CATALOGS) as Locale[];

const clock: Clock = { epochNow: () => NOW, monotonicNow: () => 0 };

const store: FireEventStore = {
  state: () => {
    throw new Error('the credit surfaces must not read the store');
  },
  subscribe: () => () => {},
  dispatch: () => {},
  setFeedStatus: () => {},
  acknowledgeSnapshotNeed: () => {},
};

/** The placeholders resolved independently of the code under test. */
const expectedContext = (locale: Locale): RenderContext => ({
  year: 2026,
  productName: CATALOGS[locale].appTitle,
});

// ── Reading a surface's output ─────────────────────────────────────────────

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

/** Visible text and link targets of an HTML fragment — tags become line breaks. */
function readHtml(html: string): RenderedAttribution {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const hrefs = [...body.matchAll(/\shref="([^"]*)"/g)].map((match) =>
    decodeEntities(match[1] ?? ''),
  );
  const text = decodeEntities(body.replace(/<[^>]*>/g, '\n'));
  return { text, hrefs };
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g, (entity) => ENTITIES[entity] ?? '');
}

// ── Probes: one per web surface, each through the surface's real code path ──

type Probe = (
  config: ClientConfig,
  locale: Locale,
  session: CreditSessionState,
  theme: ThemeName,
) => Promise<RenderedAttribution>;

const THEMES: readonly ThemeName[] = ['light', 'dark'];

/** A tile URL shaped like the one `imageryTileUrl` builds from client-config handles. */
const IMAGERY_TILES_URL = 'https://tiles.example.test/imagery/tile/{z}/{y}/{x}?token=AAPK-test';

function services(config: ClientConfig, locale: Locale): AppServices {
  return {
    store,
    clock,
    serverNow: () => NOW,
    config,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale,
    messages: CATALOGS[locale],
    setLocale: () => {},
  };
}

async function renderPage(
  Page: ComponentType,
  config: ClientConfig,
  locale: Locale,
): Promise<RenderedAttribution> {
  const { html } = await prerender(
    <AppContext.Provider value={services(config, locale)}>
      <Page />
    </AppContext.Provider>,
  );
  return readHtml(html);
}

/**
 * The swath draw the map pane would hand the controller (TASKS F15), or `null`. Set only by
 * the dedicated CelesTrak case: the credit is not a registry map-corner row, so the walked
 * combinations never draw swaths.
 */
let swathsDraw: PassSwathsDraw | null = null;

/** The same for the lightning flashes (TASKS F18): set only by the dedicated EUMETSAT case. */
let lightningDraw: LightningDraw | null = null;

async function probeMapCorner(
  config: ClientConfig,
  locale: Locale,
  session: CreditSessionState,
  theme: ThemeName = 'light',
): Promise<RenderedAttribution> {
  recorded.styles.length = 0;
  recorded.controls.length = 0;
  recorded.sources.clear();
  recorded.layers.clear();
  const controller = createMapController({
    container: {} as HTMLElement,
    store,
    theme,
    styleUrls: config.basemapStyleUrl,
    // Exactly what the map pane passes (`ui/map-pane.tsx`).
    outdoorBasemap: config.outdoorBasemap ?? null,
    detectionsUrlTemplate: config.detectionsUrlTemplate,
    attributionLine: mapCornerAttribution(clock, CATALOGS[locale]),
    initialView: { zoom: 5, lat: 42, lon: 25 },
    onSelectEvent: () => {},
    onViewportChange: () => {},
  });
  // What the map pane does with the `imageryTilesUrl` signal when the reader toggles.
  if (session.imageryOn === true) controller.setImagery(IMAGERY_TILES_URL);
  // And what it does with `effisOverlayPayload` once an EFFIS overlay is chosen and loaded
  // (TASKS G4): both overlays drawn, the burnt-area source carrying the EFFIS credit.
  if (session.effisOn === true) {
    controller.setEffisOverlays({
      fwiImageUrl: 'blob:attribution-presence',
      burntAreas: { type: 'FeatureCollection', features: [] },
      attribution: effisCreditText(clock, CATALOGS[locale]),
    });
  }
  // A forecast day ahead draws through the same FWI raster source: the day is the reader's
  // choice, so the probe records it for `drawnConditions` (V2-B1).
  drawnForecastDay = session.effisOn === true && session.gwisOn === true;
  // And `windOverlayPayload` once the wind layer is chosen and loaded (TASKS F14).
  if (session.windOn === true) controller.setWindOverlay(WIND_BODY);
  // And the predicted swaths (TASKS F15), when the dedicated case below draws them.
  if (swathsDraw !== null) controller.setPassSwaths(swathsDraw);
  // And the lightning flashes (TASKS F18), when the dedicated case below draws them.
  if (lightningDraw !== null) controller.setLightning(lightningDraw);
  // Both layers are fetched the first time one is drawn (CI-12), so their sources — and the
  // credits on them — reach the map only once that import settles.
  if (swathsDraw !== null || lightningDraw !== null) {
    await Promise.all([import('../map/pass-swaths-layer.js'), import('../map/lightning-layer.js')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // Only what reached the map counts: a control built and never added credits no one.
  const lines = recorded.controls.flatMap((control) => {
    const custom = (control as { options?: { customAttribution?: string | string[] } }).options
      ?.customAttribution;
    return custom === undefined ? [] : Array.isArray(custom) ? custom : [custom];
  });
  // MapLibre's attribution control also shows every source's `attribution` — the ones added
  // at runtime and the ones a built style document declares. (An external style URL's own
  // sources are fetched by MapLibre and are outside what this repository controls.)
  for (const source of [...recorded.sources.values(), ...styleSources()]) {
    const attribution = (source as { readonly attribution?: unknown }).attribution;
    if (typeof attribution === 'string') lines.push(attribution);
  }
  // MapLibre sets the custom attribution as HTML, so it is read as HTML.
  return readHtml(lines.join('\n'));
}

/** The last map-corner probe drew an FWI forecast day ahead (GWIS), not today's index. */
let drawnForecastDay = false;

/** The sources of every style document the controller loaded (none for a style URL). */
function styleSources(): unknown[] {
  return recorded.styles.flatMap((style) =>
    typeof style === 'object' && style !== null
      ? Object.values((style as { readonly sources?: Record<string, unknown> }).sources ?? {})
      : [],
  );
}

/**
 * The credit conditions of what the last probe *drew*, read off the recording map rather
 * than the config: the style URL's provider, or the built style's own sources (a vector
 * tile tree is the Protomaps-schema build, a `raster-dem` source is the Terrarium
 * hillshade), plus the imagery raster the controller added.
 */
function drawnConditions(): readonly CreditCondition[] {
  const drawn = new Set<CreditCondition>();
  if (drawnForecastDay) drawn.add('layer:gwis');
  for (const style of recorded.styles) {
    if (typeof style === 'string') {
      if (style.includes('openfreemap')) drawn.add('basemap:openfreemap');
      if (style.includes('protomaps')) drawn.add('basemap:protomaps');
    }
  }
  for (const source of styleSources()) {
    const type = (source as { readonly type?: unknown }).type;
    if (type === 'vector') drawn.add('basemap:protomaps');
    if (type === 'raster-dem') drawn.add('layer:terrain');
  }
  for (const [id, source] of recorded.sources) {
    if (id.startsWith('effis-')) drawn.add('layer:effis');
    else if (id === WIND_SOURCE_ID) drawn.add('derived:ecmwf');
    else if ((source as { readonly type?: unknown }).type === 'raster') drawn.add('toggle:esri');
  }
  return [...drawn].sort();
}

/** The event the comparison probe opens: closed, with a pair of GIBS days before NOW. */
const COMPARED_EVENT = {
  id: 'fw-2026-ci13',
  lon: 25.6,
  lat: 42.4,
  firstObservedAt: '2026-09-10T11:00:00Z',
  lastObservedAt: '2026-09-12T11:00:00Z',
} as const;

const PROBES = {
  'map-corner': probeMapCorner,
  // The panel exists only while the reader has it open, which is what `gibsOn` says.
  'imagery-compare': async (config, locale, session) => {
    if (session.gibsOn !== true) return { text: '', hrefs: [] };
    const { html } = await prerender(
      <AppContext.Provider value={services(config, locale)}>
        <BeforeAfter event={COMPARED_EVENT} nowMs={NOW} onClose={() => {}} />
      </AppContext.Provider>,
    );
    return readHtml(html);
  },
  // The page reads the Layers panel's choice (`effisChosen`), not the session, so the probe
  // makes the choice the session describes — and clears it, so no other probe inherits it.
  'credits-page': async (config, locale, session) => {
    setOverlays([
      ...(session.effisOn === true ? (['fwi'] as const) : []),
      ...(session.windOn === true ? (['wind'] as const) : []),
    ]);
    if (session.gwisOn === true) setFwiDay(3);
    try {
      return await renderPage(CreditsPage, config, locale);
    } finally {
      setOverlays([]);
      setFwiDay(0);
    }
  },
  about: (config, locale) => renderPage(AboutPage, config, locale),
} as const satisfies Record<CreditSurfacesOf<'web'>, Probe>;

// ── Combinations: every style the map can draw ─────────────────────────────

const withBasemap = (light: string, dark: string): ClientConfig => ({
  ...DEFAULT_CONFIG,
  basemapStyleUrl: { light, dark },
});

const NEUTRAL_BASEMAP = withBasemap(
  'https://tiles.example.test/styles/light.json',
  'https://tiles.example.test/styles/dark.json',
);

/** A complete outdoor config, shaped like what `infra/tiles/build.sh` prints. */
const OUTDOOR: OutdoorBasemapConfig = {
  tilesUrl: 'https://tiles.example.test/tiles/20260924/{z}/{x}/{y}.mvt',
  glyphsUrl: 'https://tiles.example.test/fonts/20260924/{fontstack}/{range}.pbf',
  demTilesUrl: null,
  maxzoom: 14,
};
const DEM_TILES_URL = 'https://tiles.example.test/dem/terrarium/{z}/{x}/{y}.png';

/**
 * Every basemap the map can draw. The outdoor rows keep DEFAULT_CONFIG's OpenFreeMap URLs
 * underneath — the shipped fallback — so a credit that still follows the URL instead of the
 * drawn style shows up as a wrong condition set.
 */
const BASEMAPS = {
  openfreemap: DEFAULT_CONFIG,
  'protomaps-url': withBasemap(
    'https://tiles.example.test/protomaps/light.json',
    'https://tiles.example.test/protomaps/dark.json',
  ),
  'neutral-url': NEUTRAL_BASEMAP,
  // Half-deployed (no glyphs yet) but with a DEM: falls back to OpenFreeMap, no hillshade.
  'outdoor-fallback': {
    ...DEFAULT_CONFIG,
    outdoorBasemap: { ...OUTDOOR, glyphsUrl: null, demTilesUrl: DEM_TILES_URL },
  },
  outdoor: { ...DEFAULT_CONFIG, outdoorBasemap: OUTDOOR },
  'outdoor+terrain': {
    ...DEFAULT_CONFIG,
    outdoorBasemap: { ...OUTDOOR, demTilesUrl: DEM_TILES_URL },
  },
} as const satisfies Record<string, ClientConfig>;

const IMAGERY = {
  'imagery-off': {},
  'imagery-on': { imageryOn: true },
  // An EFFIS overlay chosen in the Layers panel (TASKS G4) — a reader choice like imagery.
  'effis-on': { effisOn: true },
  // The wind context layer chosen in the Layers panel (TASKS F14).
  'wind-on': { windOn: true },
  // An FWI forecast day ahead picked in the Layers panel: the GWIS raster (V2-B1).
  'gwis-on': { effisOn: true, gwisOn: true },
  // The before/after comparison opened on an event page (V2-E2).
  'gibs-on': { gibsOn: true },
} as const satisfies Record<string, CreditSessionState>;

type BasemapKey = keyof typeof BASEMAPS;
type ImageryKey = keyof typeof IMAGERY;
type CombinationKey = `${BasemapKey}/${ImageryKey}`;

interface Combination {
  readonly key: CombinationKey;
  readonly config: ClientConfig;
  readonly session: CreditSessionState;
}

const COMBINATIONS: readonly Combination[] = (Object.keys(BASEMAPS) as BasemapKey[]).flatMap(
  (basemap) =>
    (Object.keys(IMAGERY) as ImageryKey[]).map((imagery) => ({
      key: `${basemap}/${imagery}` as const,
      config: BASEMAPS[basemap],
      session: IMAGERY[imagery],
    })),
);

const combination = (key: CombinationKey): Combination => {
  const found = COMBINATIONS.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`no combination ${key}`);
  return found;
};

const conditionsOf = ({ config, session }: Combination): readonly CreditCondition[] =>
  activeCreditConditions(config, session);

// ── Contexts: every condition the registry can name ─────────────────────────

type Context =
  | { readonly reachable: true; readonly via: CombinationKey }
  | { readonly reachable: false; readonly why: string };

const NO_SHIPPED_LAYER = 'no shipped configuration enables this layer yet';

const CONTEXTS = {
  always: { reachable: true, via: 'neutral-url/imagery-off' },
  'basemap:openfreemap': { reachable: true, via: 'openfreemap/imagery-off' },
  'basemap:protomaps': { reachable: true, via: 'outdoor/imagery-off' },
  // Reached by the reader opening the before/after comparison on an event page (V2-E2).
  'layer:gibs': { reachable: true, via: 'neutral-url/gibs-on' },
  // Reached by the reader choosing an EFFIS overlay in the Layers panel (TASKS G4).
  'layer:effis': { reachable: true, via: 'neutral-url/effis-on' },
  // Reached by the reader picking an FWI forecast day ahead in the Layers panel (V2-B1).
  'layer:gwis': { reachable: true, via: 'neutral-url/gwis-on' },
  // The outdoor style's Terrarium hillshade, drawn when a DEM mirror is configured (G3).
  'layer:terrain': { reachable: true, via: 'outdoor+terrain/imagery-off' },
  'layer:landsat': { reachable: false, why: NO_SHIPPED_LAYER },
  'imagery:sentinel-unmodified': { reachable: false, why: NO_SHIPPED_LAYER },
  // Reached by the reader choosing the wind layer in the Layers panel (TASKS F14).
  'derived:ecmwf': { reachable: true, via: 'neutral-url/wind-on' },
  // Reached by the reader's toggle while the server offers imagery (TASKS G6).
  'toggle:esri': { reachable: true, via: 'neutral-url/imagery-on' },
  never: { reachable: false, why: 'the registry never owes these' },
} as const satisfies Record<CreditCondition, Context>;

const CONDITIONS = Object.keys(CONTEXTS) as CreditCondition[];

const WEB_SURFACES = (Object.keys(PROBES) as CreditSurfacesOf<'web'>[]).sort();

// ── The register ─────────────────────────────────────────────────────────────

const inAll = (surface: string, gap: string): string[] =>
  COMBINATIONS.map(({ key }) => `${surface} ${key} ${gap}`);
const inEach = (keys: readonly CombinationKey[], surface: string, gap: string): string[] =>
  keys.map((key) => `${surface} ${key} ${gap}`);

/**
 * `<surface> <combination> <credit id> <text|href>` for every owed credit the surface does
 * not carry. Each line is a licence finding for the founder, not a test to be made green
 * with copy: the credit wording is a licence condition and the corner line is frozen.
 */
const KNOWN_FINDINGS = [
  // The corner line says "Contains modified Copernicus Sentinel data & Service information
  // [YEAR]"; the registry's service credit is its own sentence, which the merge dropped.
  ...inAll('map-corner', 'copernicus-service text'),
  // ODbL asks for a link to the licence or copyright page; the corner line is plain text.
  ...inAll('map-corner', 'osm href'),
  // The registry owes "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" (only the
  // "OpenFreeMap" part is optional); the corner carries "© OpenStreetMap contributors |
  // © OpenMapTiles". Whether the external style's own attribution discharges it is not
  // something this repository controls or tests. The half-deployed outdoor config draws
  // OpenFreeMap too, so it owes the same.
  ...inEach(
    [
      'openfreemap/imagery-off',
      'openfreemap/imagery-on',
      'openfreemap/effis-on',
      'openfreemap/wind-on',
      'openfreemap/gwis-on',
      'openfreemap/gibs-on',
      'outdoor-fallback/imagery-off',
      'outdoor-fallback/imagery-on',
      'outdoor-fallback/effis-on',
      'outdoor-fallback/wind-on',
      'outdoor-fallback/gwis-on',
      'outdoor-fallback/gibs-on',
    ],
    'map-corner',
    'openfreemap text',
  ),
  // The corner says "Terrain: Tilezen/Mapzen"; the registry's `terrarium-short` is
  // "Terrain: Mapzen/Tilezen & sources". Red the moment the hillshade is drawn (G3).
  ...inEach(
    [
      'outdoor+terrain/imagery-off',
      'outdoor+terrain/imagery-on',
      'outdoor+terrain/effis-on',
      'outdoor+terrain/wind-on',
      'outdoor+terrain/gwis-on',
      'outdoor+terrain/gibs-on',
    ],
    'map-corner',
    'terrarium-short text',
  ),
];

async function findings(locale: Locale): Promise<string[]> {
  const found = new Set<string>();
  for (const surface of WEB_SURFACES) {
    for (const entry of COMBINATIONS) {
      // The pages do not depend on the theme; the corner is probed in both, and a gap in
      // either theme is a gap.
      for (const theme of surface === 'map-corner' ? THEMES : THEMES.slice(0, 1)) {
        const rendered = await PROBES[surface](entry.config, locale, entry.session, theme);
        const gaps = attributionGaps(
          surface,
          conditionsOf(entry),
          rendered,
          expectedContext(locale),
        );
        for (const gap of gaps) found.add(`${surface} ${entry.key} ${gap.creditId} ${gap.missing}`);
      }
    }
  }
  return [...found].sort();
}

// ── The gate ─────────────────────────────────────────────────────────────────

describe('CI-13 — attribution presence on the web surfaces', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { hash: '' });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes exactly the surfaces the registry gives the web', () => {
    const owned = (Object.keys(CREDIT_SURFACE_OWNER) as CreditSurface[])
      .filter((surface) => CREDIT_SURFACE_OWNER[surface] === 'web')
      .sort();
    expect(WEB_SURFACES).toStrictEqual(owned);
    // Every surface a credit names has an owner, so none can fall between the two halves.
    const named = new Set(CREDITS.flatMap((credit) => credit.surfaces));
    for (const surface of named) expect(Object.keys(CREDIT_SURFACE_OWNER)).toContain(surface);
  });

  it('reaches each reachable context through configuration, and no other', () => {
    for (const condition of CONDITIONS) {
      const context: Context = CONTEXTS[condition];
      if (context.reachable && condition !== 'always') {
        expect(conditionsOf(combination(context.via)), condition).toContain(condition);
      }
    }
    // A configuration that starts activating an "unreachable" condition must move it into
    // the probed set — otherwise its credits would be owed and never checked.
    const produced = new Set(COMBINATIONS.flatMap((entry) => conditionsOf(entry)));
    const shipped = activeCreditConditions(DEFAULT_CONFIG);
    for (const condition of CONDITIONS.filter((c) => !CONTEXTS[c].reachable)) {
      expect(produced.has(condition), condition).toBe(false);
      expect(shipped, condition).not.toContain(condition);
    }
    // And every reachable one is produced by some combination (`always` needs none).
    for (const condition of CONDITIONS.filter((c) => CONTEXTS[c].reachable)) {
      if (condition !== 'always') expect(produced.has(condition), condition).toBe(true);
    }
  });

  it.each(COMBINATIONS.map((entry) => entry.key))(
    'the credits describe what the map draws (%s)',
    async (key) => {
      const entry = combination(key);
      // The before/after comparison is a panel, not something the map draws (V2-E2).
      const expected = conditionsOf(entry)
        .filter((condition) => condition !== 'layer:gibs')
        .sort();
      for (const theme of THEMES) {
        await probeMapCorner(entry.config, 'en', entry.session, theme);
        expect(drawnConditions(), `${key} ${theme}`).toStrictEqual(expected);
      }
    },
  );

  it('asks something of every web surface (the check is not vacuous)', () => {
    for (const surface of WEB_SURFACES) {
      const owed = COMBINATIONS.flatMap((entry) => assertableCredits(surface, conditionsOf(entry)));
      expect(owed.length, surface).toBeGreaterThan(0);
    }
  });

  // The Esri credit is plugin-injected, so `attributionGaps` skips it; this is its check.
  it.each(LOCALES)(
    'the map corner carries the Esri credit exactly while imagery is on (%s)',
    async (locale) => {
      const esri = CREDITS.find((credit) => credit.id === 'esri-world-imagery');
      expect(esri?.condition).toBe('toggle:esri');
      const text = esri?.text ?? '';
      expect(text).not.toBe('');

      for (const entry of COMBINATIONS) {
        const on = entry.session.imageryOn === true;
        expect(conditionsOf(entry).includes('toggle:esri'), entry.key).toBe(on);
        for (const theme of THEMES) {
          const rendered = await probeMapCorner(entry.config, locale, entry.session, theme);
          expect(rendered.text.includes(text), `${entry.key} ${theme}`).toBe(on);
        }
      }
    },
  );

  // The CelesTrak credit is a credits-page row; the swath layer adds it to the map corner on
  // its source while swaths are drawn (TASKS F15). This is that check.
  it.each(LOCALES)(
    'the map corner carries the CelesTrak credit exactly while swaths are drawn (%s)',
    async (locale) => {
      const credit = celestrakCredit(clock, CATALOGS[locale]);
      expect(credit?.text).toContain('CelesTrak');
      const text = credit?.text ?? '';
      const off = await probeMapCorner(DEFAULT_CONFIG, locale, {});
      expect(off.text.includes(text)).toBe(false);
      swathsDraw = {
        collection: { type: 'FeatureCollection', features: [] },
        attribution: text,
      };
      try {
        const on = await probeMapCorner(DEFAULT_CONFIG, locale, {});
        expect(on.text).toContain(text);
      } finally {
        swathsDraw = null;
      }
    },
  );

  // The EUMETSAT credit is a credits-page row; the lightning layer adds it to the map corner
  // on its source while flashes are drawn (TASKS F18). This is that check.
  it.each(LOCALES)(
    'the map corner carries the EUMETSAT credit exactly while flashes are drawn (%s)',
    async (locale) => {
      const text = eumetsatCreditText(clock, CATALOGS[locale]);
      expect(text).toContain('EUMETSAT');
      const off = await probeMapCorner(DEFAULT_CONFIG, locale, {});
      expect(off.text.includes(text)).toBe(false);
      lightningDraw = {
        collection: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [25, 42] },
              properties: { ageClass: 0 },
            },
          ],
        },
        attribution: text,
      };
      try {
        const on = await probeMapCorner(DEFAULT_CONFIG, locale, {});
        expect(on.text).toContain(text);
      } finally {
        lightningDraw = null;
      }
    },
  );

  it.each(LOCALES)(
    'every owed credit is rendered, except the recorded findings (%s)',
    async (locale) => {
      expect(await findings(locale)).toStrictEqual([...KNOWN_FINDINGS].sort());
    },
  );
});
