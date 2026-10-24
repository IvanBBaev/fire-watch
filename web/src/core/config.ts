/**
 * Client configuration — one object, defaulted for the fixture-driven foundation.
 *
 * The read path (Track E) and self-hosted tiles (WP5) do not exist yet; the defaults
 * point at fixture files served from `public/` and at the one real endpoint, the probe
 * API's freshness route (proxied in dev). Swapping to the real read path or to WP5 tiles
 * is a values change here — no contract moves (ADR-001 A1.1, IMPLEMENTATION-PLAN WP5).
 */

import type { OutdoorBasemapConfig, ThemeName } from './types.js';

export interface ClientConfig {
  /** Wire-compatible with the future `/snapshot.json` (ADR-003 D1). */
  readonly snapshotUrl: string;
  /** `{id}` is replaced with the event's public id; `null` disables detection detail. */
  readonly detectionsUrlTemplate: string | null;
  /** The canonical freshness path (TASKS A22); dev-proxied to the local probe API. */
  readonly freshnessUrl: string;
  readonly pollIntervalMs: number;
  /** Fraction of the interval used as ± jitter so clients do not thundering-herd a CDN. */
  readonly pollJitterRatio: number;
  readonly freshnessPollIntervalMs: number;
  /** One value per theme is the whole tile-swap seam (ADR-001 A1.1). */
  readonly basemapStyleUrl: Readonly<Record<ThemeName, string>>;
  /**
   * The self-hosted outdoor basemap (TASKS G3). Optional so older literal configs still
   * type-check; `null` URLs mean "not deployed" and `basemapStyleUrl` stays in charge.
   */
  readonly outdoorBasemap?: OutdoorBasemapConfig;
  /** The SSE endpoint (ADR-003 D1 T0, E2). */
  readonly streamUrl: string;
  /** Runtime overrides for this object (ADR-003 A1.2); defaults win until it exists. */
  readonly clientConfigUrl: string;
  /**
   * Whether the supervisor may leave polling for the stream at all. `false` is the
   * CI-7 configuration: every feature must be T1-complete, and the e2e suite proves it by
   * never letting the stream in (ADR-003 D1, GATES CI-7).
   */
  readonly sseEnabled: boolean;
  /**
   * The full-snapshot rhythm that runs underneath a live stream and bounds a cursor-mode
   * poller (ADR-003 D3 "safety snapshot every 10 min", A1.5 "at least every 10 min").
   */
  readonly safetySnapshotIntervalMs: number;
  /** After a stream error or `degrade`, how long polling stays put before SSE is re-offered
   *  (ADR-003 A1.1: 30 min continuously healthy; L-2 criterion 4: no flapping). */
  readonly sseReofferHysteresisMs: number;
  /** A fetched snapshot older than this, in server time, flips the supervisor to T2
   *  (ADR-003 A1.2 "T2 freshness bound", Decision 1 table: ≤5 min). */
  readonly staticFlipStaleMs: number;
  /**
   * The static copy of `/snapshot.json` on the second hostname (ADR-003 A1.2), baked in at
   * build time; `null` means no static tier is deployed and T2 polls the origin instead.
   */
  readonly staticSnapshotUrl: string | null;
  /**
   * The F14 wind forecast step: a committed fixture by default, the API's route in live
   * mode. Optional so older literal configs still type-check (absent = the API's route).
   */
  readonly windOverlayUrl?: string;
  /**
   * The F15 satellite swaths over the polled box: a committed fixture by default, the
   * API's route in live mode. Optional so older literal configs still type-check (absent =
   * the API's route).
   */
  readonly passSwathsUrl?: string;
  /**
   * The F18 recent lightning flashes: a committed fixture by default, the API's route in
   * live mode. Optional so older literal configs still type-check (absent = the API's route).
   */
  readonly lightningOverlayUrl?: string;
  /**
   * The F18 lightning context of one event (`{id}` is its public id): committed fixtures by
   * default, the API's route in live mode. Optional; absent hides the note.
   */
  readonly lightningContextUrlTemplate?: string;
  /**
   * The V2-E3 Copernicus EMS activation list behind the event page's badge: a committed
   * (synthetic) fixture by default, the API's route in live mode. Optional; absent hides
   * the badge.
   */
  readonly cemsActivationsUrl?: string;
  /**
   * The F15 satellite-pass document for one grid cell: `{cell}` is replaced with the cell id.
   * The default is one committed fixture (no `{cell}`, so every cell reads the same file);
   * live mode is the API's route. Optional so older literal configs still type-check.
   */
  readonly passesUrlTemplate?: string;
}

export const DEFAULT_CONFIG: ClientConfig = {
  snapshotUrl: '/fixtures/snapshot.json',
  detectionsUrlTemplate: '/fixtures/detections/{id}.json',
  freshnessUrl: '/api/health/freshness',
  pollIntervalMs: 45_000,
  pollJitterRatio: 0.2,
  freshnessPollIntervalMs: 60_000,
  streamUrl: '/api/v1/stream',
  clientConfigUrl: '/api/v1/client-config',
  sseEnabled: false,
  safetySnapshotIntervalMs: 10 * 60_000,
  sseReofferHysteresisMs: 30 * 60_000,
  staticFlipStaleMs: 5 * 60_000,
  staticSnapshotUrl: null,
  windOverlayUrl: '/fixtures/wind/latest.json',
  passSwathsUrl: '/fixtures/passes/swaths.json',
  lightningOverlayUrl: '/fixtures/lightning/recent.json',
  lightningContextUrlTemplate: '/fixtures/lightning-context/{id}.json',
  cemsActivationsUrl: '/fixtures/cems/activations.json',
  passesUrlTemplate: '/fixtures/passes/sample.json',
  basemapStyleUrl: {
    light: 'https://tiles.openfreemap.org/styles/positron',
    dark: 'https://tiles.openfreemap.org/styles/dark',
  },
  // Not deployed yet: `infra/tiles/build.sh` prints the values to put here after an upload.
  outdoorBasemap: {
    tilesUrl: null,
    glyphsUrl: null,
    demTilesUrl: null,
    demBounds: null,
    maxzoom: 14,
  },
};

/**
 * Where the map wakes up when the URL carries no `#map=` state: the whole polled box.
 *
 * Centred on `POLLING_AREA` (core/geo/coverage.ts — 20/39 to 31/46), which puts Bulgaria in
 * the middle of the frame while Greece, Turkish Thrace, Serbia, North Macedonia and
 * southern Romania are all on screen. Opening on Bulgaria alone made the map look like a
 * Bulgaria-only product; we poll the Balkans, so the first frame shows the Balkans.
 * The coverage *promise* is unchanged and narrower — see `mapControls.coverageNote`.
 */
export const DEFAULT_VIEW = { zoom: 5.8, lat: 42.4, lon: 25.4 } as const;

/**
 * Where the client reads events from: `fixtures` (the default, and what tests, e2e and
 * CI-7 run against) or `live`, the local API's `/snapshot.json` (`pnpm dev:live`).
 */
export type DataSource = 'fixtures' | 'live';

/**
 * The build's data source from a raw env value (`VITE_FIRE_WATCH_DATA`). Anything but an
 * explicit `live` is the fixtures, so a typo can never point CI at a server.
 */
export function readDataSource(raw: string | undefined): DataSource {
  return raw?.trim().toLowerCase() === 'live' ? 'live' : 'fixtures';
}

/** Only a loopback page may point the basemap at its own dev server. */
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u;

/**
 * The locally built basemap (TASKS G3), from the raw env value `VITE_FIRE_WATCH_LOCAL_TILES`
 * and the page's origin. `web/vite.config.ts` sets the value to the path it mounted the
 * `build.sh` output under (`/__local-tiles`) only when `FIRE_WATCH_LOCAL_TILES_DIR` is set;
 * unset — every CI and production build — this is `null` and nothing changes. A value that
 * is not a plain absolute path, or a page that is not on loopback, is `null` too: the
 * local tiles exist on one machine, and no shipped origin may be pointed at them.
 *
 * `rawDem` is `VITE_FIRE_WATCH_LOCAL_DEM`, which the same plugin sets to `1` only when a
 * Terrarium mirror (`cli.js dem-mirror`) is being served beside the tiles; then
 * `demTilesUrl` points at it and the style draws hillshade (and the terrain credits follow,
 * `layer:terrain`). Anything else leaves `demTilesUrl` null — no hillshade, no 404s.
 *
 * `rawDemBounds` is `VITE_FIRE_WATCH_LOCAL_DEM_BOUNDS`, `west,south,east,north` from the
 * served mirror's manifest (`infra/tiles/dev-serve.ts` localDemBounds); it becomes
 * `demBounds` only beside a DEM and only when it parses, otherwise `null` (no `bounds`).
 */
export function readLocalTiles(
  raw: string | undefined,
  origin: string,
  rawDem?: string,
  rawDemBounds?: string,
): OutdoorBasemapConfig | null {
  const prefix = raw?.trim() ?? '';
  if (!/^\/[\w-]+$/u.test(prefix) || !LOOPBACK_ORIGIN.test(origin)) return null;
  const dem = rawDem?.trim() === '1';
  return {
    tilesUrl: `${origin}${prefix}/tiles/{z}/{x}/{y}.mvt`,
    glyphsUrl: `${origin}${prefix}/fonts/{fontstack}/{range}.pbf`,
    demTilesUrl: dem ? `${origin}${prefix}/dem/terrarium/{z}/{x}/{y}.png` : null,
    demBounds: dem ? parseBounds(rawDemBounds) : null,
    maxzoom: 14,
  };
}

/** `west,south,east,north` → a 4-tuple of finite numbers, or `null`. Range checks live in `outdoorConfigProblem`. */
function parseBounds(raw: string | undefined): readonly [number, number, number, number] | null {
  const parts = (raw ?? '').split(',').map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => part === '')) return null;
  const [west, south, east, north] = parts.map(Number);
  if (west === undefined || south === undefined || east === undefined || north === undefined)
    return null;
  const bounds = [west, south, east, north] as const;
  return bounds.every(Number.isFinite) ? bounds : null;
}

/** `config` drawing the outdoor style from local tiles, or unchanged when there are none. */
export function withLocalTiles(
  config: ClientConfig,
  local: OutdoorBasemapConfig | null,
): ClientConfig {
  return local === null ? config : { ...config, outdoorBasemap: local };
}

/**
 * The API's per-event detections route (`server/src/adapters/http/event-detections-route.ts`),
 * the same GeoJSON shape as the fixture files. Proxied under `/api` in dev.
 */
export const LIVE_DETECTIONS_URL_TEMPLATE = '/api/v1/events/{id}/detections';

/** The API's satellite-pass route (`server/src/adapters/http/passes-route.ts`). */
export const LIVE_PASSES_URL_TEMPLATE = '/api/v1/passes/{cell}';

/**
 * `config` pointed at the chosen data source. Live reads the API's snapshot and its
 * per-event detections route (both proxied in dev); the fixture template must never
 * survive into live mode, where it would show another event's pixels.
 */
export function withDataSource(config: ClientConfig, source: DataSource): ClientConfig {
  if (source === 'fixtures') return config;
  return {
    ...config,
    snapshotUrl: '/snapshot.json',
    detectionsUrlTemplate: LIVE_DETECTIONS_URL_TEMPLATE,
    windOverlayUrl: '/overlays/wind/latest.json',
    passSwathsUrl: '/overlays/passes/swaths.json',
    lightningOverlayUrl: '/overlays/lightning/recent.json',
    lightningContextUrlTemplate: '/api/v1/events/{id}/lightning-context',
    cemsActivationsUrl: '/overlays/cems/activations.json',
    passesUrlTemplate: LIVE_PASSES_URL_TEMPLATE,
  };
}
