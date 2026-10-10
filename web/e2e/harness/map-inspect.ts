/**
 * Asserting overlays through the real map (TASKS CI-7, CI-13; map roadmap F14–F18).
 *
 * The overlay suites block the third-party basemap, so the MapLibre style never finishes
 * loading and no runtime overlay source or layer ever reaches the map — only unit stubs
 * proved them. This module gives a page two things:
 *
 *   * **A basemap that loads.** The local stand-in (`stand-in-basemap.ts`) replaces both
 *     configured style URLs through the page's `rewrite` hook, so the app's production
 *     style URL config is untouched and no third-party request is made — which also means
 *     these pages run with an *empty* console-error allowlist and nothing blocked.
 *   * **A read of the live style.** The opt-in, inert hook in `src/map/map-inspection.ts`
 *     is switched on for this page only; it returns plain JSON (layer ids in paint order,
 *     source ids, rendered counts). No production page sets the key.
 *
 * The map's attribution corner is read from the DOM MapLibre renders it into, so the
 * credit assertions see what a reader sees.
 */

import type { Page } from 'puppeteer-core';

import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { FIRE_LAYER_IDS } from '../../src/map/layer-registry.js';
import { MAP_INSPECTION_KEY, MAP_INSPECTION_READ_KEY } from '../../src/map/map-inspection.js';
import type { MapInspection } from '../../src/map/map-inspection.js';
import { startStandInBasemap } from './stand-in-basemap.js';
import type { StandInBasemap } from './stand-in-basemap.js';
import { until } from './page.js';

/** Small tiles: these suites need a loaded style, not a realistic byte weight. */
const TINY_BASEMAP = { tileBytes: 1024, tileSize: 256, maxzoom: 14 } as const;

export interface LoadableBasemap {
  readonly basemap: StandInBasemap;
  /** Spread into `openInstrumentedPage` options (merge `extraOrigins`/`rewrite` if needed). */
  readonly pageOptions: {
    readonly extraOrigins: readonly string[];
    readonly rewrite: Readonly<Record<string, string>>;
  };
}

/** A stand-in basemap and the page options that route both configured styles to it. */
export async function startLoadableBasemap(): Promise<LoadableBasemap> {
  const basemap = await startStandInBasemap(TINY_BASEMAP);
  return {
    basemap,
    pageOptions: {
      extraOrigins: [basemap.baseUrl],
      rewrite: Object.fromEntries(
        Object.values(DEFAULT_CONFIG.basemapStyleUrl).map((url) => [url, basemap.styleUrl]),
      ),
    },
  };
}

/** Opt this page into the map inspection. Call before the first `goto`. */
export async function enableMapInspection(page: Page): Promise<void> {
  await page.evaluateOnNewDocument((key: string) => {
    (globalThis as unknown as Record<string, unknown>)[key] = true;
  }, MAP_INSPECTION_KEY);
}

/** One read of the live style, or `null` before the controller installed the read. */
export async function readMap(
  page: Page,
  renderedLayers: readonly string[] = [],
): Promise<MapInspection | null> {
  return page.evaluate(
    (key: string, layers: readonly string[]) => {
      const read = (globalThis as unknown as Record<string, unknown>)[key];
      return typeof read === 'function'
        ? (read as (ids: readonly string[]) => MapInspection)(layers)
        : null;
    },
    MAP_INSPECTION_READ_KEY,
    renderedLayers,
  );
}

/** Waits until the style is loaded and carries the fire layers; returns that read. */
export async function untilStyleLoaded(page: Page, timeoutMs: number): Promise<MapInspection> {
  return until(
    async () => {
      const read = await readMap(page);
      return read !== null && read.styleLoaded && read.layers.includes(FIRE_LAYER_IDS[0])
        ? read
        : null;
    },
    { timeoutMs, what: 'the map style to load with the fire layers' },
  );
}

/** The text of the map's attribution corner (empty when the control is not rendered). */
export async function cornerText(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector('.maplibregl-ctrl-attrib-inner')?.textContent ?? '',
  );
}

/**
 * Why `ids` are not all present and below every fire layer in `read`, or `null` if they
 * are. "Below" is paint order: a lower index in `getStyle().layers` paints first.
 */
export function belowFireDefect(read: MapInspection, ids: readonly string[]): string | null {
  const firstFire = Math.min(
    ...FIRE_LAYER_IDS.map((id) => read.layers.indexOf(id)).filter((index) => index >= 0),
  );
  if (!Number.isFinite(firstFire)) return 'no fire layer in the style';
  for (const id of ids) {
    const index = read.layers.indexOf(id);
    if (index < 0) return `layer ${id} is not in the style`;
    if (index > firstFire)
      return `layer ${id} (#${index}) paints above the fire layers (#${firstFire})`;
  }
  return null;
}

/** Whether none of `ids` is in the style any more. */
export function noneOf(read: MapInspection, ids: readonly string[]): boolean {
  return ids.every((id) => !read.layers.includes(id));
}
