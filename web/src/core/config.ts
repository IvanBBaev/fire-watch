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
  basemapStyleUrl: {
    light: 'https://tiles.openfreemap.org/styles/positron',
    dark: 'https://tiles.openfreemap.org/styles/dark',
  },
  // Not deployed yet: `infra/tiles/build.sh` prints the values to put here after an upload.
  outdoorBasemap: {
    tilesUrl: null,
    glyphsUrl: null,
    demTilesUrl: null,
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
