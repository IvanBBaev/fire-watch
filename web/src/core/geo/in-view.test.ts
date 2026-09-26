import { describe, expect, it } from 'vitest';

import { partitionByViewport } from './in-view.js';
import type { MapViewport } from './viewport.js';

/** A frame roughly over central Bulgaria, centred on Stara Zagora. */
const VIEWPORT: MapViewport = {
  west: 24.0,
  south: 41.8,
  east: 26.6,
  north: 43.0,
  zoom: 9,
  lon: 25.3,
  lat: 42.4,
};

const near = { id: 'near', lon: 25.35, lat: 42.42 };
const middle = { id: 'middle', lon: 25.9, lat: 42.6 };
const far = { id: 'far', lon: 26.4, lat: 42.95 };
const outside = { id: 'outside', lon: 23.32, lat: 42.7 };

const ids = <T extends { readonly id: string }>(items: readonly T[]) => items.map((i) => i.id);

describe('partitionByViewport', () => {
  it('keeps only what the frame shows and counts what it left out', () => {
    const result = partitionByViewport([far, outside, near], VIEWPORT);
    expect(ids(result.inView)).toEqual(['near', 'far']);
    expect(result.outsideCount).toBe(1);
  });

  it('orders survivors by distance from the camera centre', () => {
    const result = partitionByViewport([far, middle, near], VIEWPORT);
    expect(ids(result.inView)).toEqual(['near', 'middle', 'far']);
  });

  it('scales longitude by latitude, so east-west distance is not overstated', () => {
    // At 42.4 N a degree of longitude is ~0.74 of a degree of latitude. 1.0 degrees east
    // is therefore the *shorter* hop, even though it is the larger raw delta.
    const east = { id: 'east', lon: VIEWPORT.lon + 1.0, lat: VIEWPORT.lat };
    const north = { id: 'north', lon: VIEWPORT.lon, lat: VIEWPORT.lat + 0.8 };
    const wide: MapViewport = { ...VIEWPORT, west: 20, east: 31, south: 39, north: 46 };
    expect(ids(partitionByViewport([north, east], wide).inView)).toEqual(['east', 'north']);
  });

  it('keeps the input order among equidistant items', () => {
    const west = { id: 'west', lon: VIEWPORT.lon - 0.4, lat: VIEWPORT.lat };
    const east = { id: 'east', lon: VIEWPORT.lon + 0.4, lat: VIEWPORT.lat };
    expect(ids(partitionByViewport([east, west], VIEWPORT).inView)).toEqual(['east', 'west']);
  });

  it('reports an empty frame without pretending the events are gone', () => {
    const result = partitionByViewport([outside, outside], VIEWPORT);
    expect(result.inView).toEqual([]);
    expect(result.outsideCount).toBe(2);
  });

  it('does not mutate the caller s array', () => {
    const items = [far, near];
    partitionByViewport(items, VIEWPORT);
    expect(ids(items)).toEqual(['far', 'near']);
  });
});
