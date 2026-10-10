/**
 * The e2e map inspection: a read-only view of the live MapLibre style for the e2e harness.
 *
 * Overlay drawing (wind, pass swaths, lightning, static sources, EFFIS) is proven by unit
 * stubs, but only the real map can show that a layer actually reached the style, sits
 * below the fire layers and is gone again when toggled off. The harness needs to read
 * that without the app shipping a handle on its map to every reader.
 *
 * Opt-in and inert, exactly like the map-ready probe (`map-ready-probe.ts`): the controller
 * reads {@link MAP_INSPECTION_KEY} off `globalThis` when it creates the map and installs
 * nothing unless it is exactly `true`. No production page sets it, so a reader's browser
 * never gets {@link MAP_INSPECTION_READ_KEY} on its global scope. The read returns plain
 * JSON (ids and counts) — never the map object — so even an opted-in page exposes no way
 * to change the map.
 */

/** Set to `true` on `globalThis` before the app loads to get the read installed. */
export const MAP_INSPECTION_KEY = '__fireWatchE2eMapInspection';

/** Where the read function lives on `globalThis` once installed. */
export const MAP_INSPECTION_READ_KEY = '__fireWatchE2eReadMap';

/** What one read reports about the live style. */
export interface MapInspection {
  /** Whether MapLibre reports the style as loaded; layer calls throw before that. */
  readonly styleLoaded: boolean;
  /** Layer ids in paint order, bottom to top. Empty while the style is not loaded. */
  readonly layers: readonly string[];
  /** Source ids. Empty while the style is not loaded. */
  readonly sources: readonly string[];
  /** Rendered feature count per requested layer id that is in the style. */
  readonly rendered: Readonly<Record<string, number>>;
}

/** The slice of the MapLibre map the read needs — structural, so a unit test can stub it. */
export interface InspectableMap {
  isStyleLoaded(): boolean | void;
  getStyle(): {
    readonly layers?: readonly { readonly id: string }[];
    readonly sources?: Readonly<Record<string, unknown>>;
  };
  queryRenderedFeatures(options: { layers: string[] }): readonly unknown[];
}

/** Whether the page opted in. Only a literal `true` counts. */
export function mapInspectionEnabled(scope: object = globalThis): boolean {
  return (scope as Record<string, unknown>)[MAP_INSPECTION_KEY] === true;
}

const EMPTY: MapInspection = { styleLoaded: false, layers: [], sources: [], rendered: {} };

/** One read of the map. Never throws: a style mid-swap reads as not loaded. */
export function inspectMap(
  map: InspectableMap,
  renderedLayers: readonly string[] = [],
): MapInspection {
  try {
    if (map.isStyleLoaded() !== true) return EMPTY;
    const style = map.getStyle();
    const layers = (style.layers ?? []).map((layer) => layer.id);
    const present = new Set(layers);
    const rendered: Record<string, number> = {};
    for (const id of renderedLayers) {
      if (present.has(id)) rendered[id] = map.queryRenderedFeatures({ layers: [id] }).length;
    }
    return { styleLoaded: true, layers, sources: Object.keys(style.sources ?? {}), rendered };
  } catch {
    return EMPTY;
  }
}

/**
 * Installs the read on `scope` when the page opted in; returns the uninstaller (a no-op
 * when nothing was installed). The controller calls the uninstaller on destroy.
 */
export function installMapInspection(map: InspectableMap, scope: object = globalThis): () => void {
  if (!mapInspectionEnabled(scope)) return () => undefined;
  const record = scope as Record<string, unknown>;
  const read = (renderedLayers?: readonly string[]): MapInspection =>
    inspectMap(map, Array.isArray(renderedLayers) ? renderedLayers : []);
  record[MAP_INSPECTION_READ_KEY] = read;
  return () => {
    if (record[MAP_INSPECTION_READ_KEY] === read) delete record[MAP_INSPECTION_READ_KEY];
  };
}
