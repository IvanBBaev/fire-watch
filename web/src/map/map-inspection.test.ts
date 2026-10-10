import { describe, expect, it } from 'vitest';

import {
  MAP_INSPECTION_KEY,
  MAP_INSPECTION_READ_KEY,
  inspectMap,
  installMapInspection,
  mapInspectionEnabled,
} from './map-inspection.js';
import type { InspectableMap, MapInspection } from './map-inspection.js';

function stubMap(loaded: boolean, layers: string[], sources: string[]): InspectableMap {
  return {
    isStyleLoaded: () => loaded,
    getStyle: () => ({
      layers: layers.map((id) => ({ id })),
      sources: Object.fromEntries(sources.map((id) => [id, {}])),
    }),
    queryRenderedFeatures: ({ layers: wanted }) => (wanted[0] === 'fire-dot' ? [{}, {}] : []),
  };
}

describe('map inspection', () => {
  it('is off unless the key is literally true', () => {
    expect(mapInspectionEnabled({})).toBe(false);
    expect(mapInspectionEnabled({ [MAP_INSPECTION_KEY]: 'true' })).toBe(false);
    expect(mapInspectionEnabled({ [MAP_INSPECTION_KEY]: 1 })).toBe(false);
    expect(mapInspectionEnabled({ [MAP_INSPECTION_KEY]: true })).toBe(true);
  });

  it('is off in a plain global scope', () => {
    expect(mapInspectionEnabled()).toBe(false);
  });

  it('installs nothing unless the page opted in', () => {
    const scope: Record<string, unknown> = {};
    const uninstall = installMapInspection(stubMap(true, ['a'], ['s']), scope);
    expect(scope[MAP_INSPECTION_READ_KEY]).toBeUndefined();
    uninstall();
    expect(Object.keys(scope)).toEqual([]);
  });

  it('installs a JSON-only read when opted in, and removes it on uninstall', () => {
    const scope: Record<string, unknown> = { [MAP_INSPECTION_KEY]: true };
    const uninstall = installMapInspection(
      stubMap(true, ['background', 'fire-dot'], ['fire-events']),
      scope,
    );
    const read = scope[MAP_INSPECTION_READ_KEY] as (layers?: string[]) => MapInspection;
    const result = read(['fire-dot', 'absent']);
    expect(result).toEqual({
      styleLoaded: true,
      layers: ['background', 'fire-dot'],
      sources: ['fire-events'],
      rendered: { 'fire-dot': 2 },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    uninstall();
    expect(scope[MAP_INSPECTION_READ_KEY]).toBeUndefined();
  });

  it('reads an unloaded or throwing style as not loaded', () => {
    expect(inspectMap(stubMap(false, ['a'], ['s'])).styleLoaded).toBe(false);
    const throwing: InspectableMap = {
      isStyleLoaded: () => true,
      getStyle: () => {
        throw new Error('style mid-swap');
      },
      queryRenderedFeatures: () => [],
    };
    expect(inspectMap(throwing)).toEqual({
      styleLoaded: false,
      layers: [],
      sources: [],
      rendered: {},
    });
  });
});
