import { describe, expect, it } from 'vitest';

import {
  MAP_READY_PROBE_KEY,
  buildMapReadyProbe,
  isMapReadyProbe,
  mapReadyProbeDefect,
  mapReadyProbeEnabled,
} from './map-ready-probe.js';

describe('map-ready probe', () => {
  it('is off unless the key is literally true', () => {
    expect(mapReadyProbeEnabled({})).toBe(false);
    expect(mapReadyProbeEnabled({ [MAP_READY_PROBE_KEY]: 'true' })).toBe(false);
    expect(mapReadyProbeEnabled({ [MAP_READY_PROBE_KEY]: 1 })).toBe(false);
    expect(mapReadyProbeEnabled({ [MAP_READY_PROBE_KEY]: true })).toBe(true);
  });

  it('is off in a plain global scope', () => {
    expect(mapReadyProbeEnabled()).toBe(false);
  });

  it('compares ids as sets, so tile-edge duplicates do not inflate the rendered count', () => {
    const probe = buildMapReadyProbe({
      fireDotLayerPresent: true,
      visibleIds: ['a', 'b', 'b'],
      renderedIds: ['a', 'a', 'a'],
    });
    expect(probe).toEqual({
      fireDotLayerPresent: true,
      visibleFireEvents: 2,
      renderedFireDots: 1,
      missing: ['b'],
    });
    expect(mapReadyProbeDefect(probe)).toMatch(/rendered 1 of 2 .*missing: b/);
  });

  it('passes when every in-view event rendered, extra rendered ones included', () => {
    const probe = buildMapReadyProbe({
      fireDotLayerPresent: true,
      visibleIds: ['a', 'b'],
      renderedIds: ['b', 'a', 'c'],
    });
    expect(mapReadyProbeDefect(probe)).toBeNull();
  });

  it('fails on an absent layer, an empty viewport and a layer that rendered nothing', () => {
    expect(
      mapReadyProbeDefect(
        buildMapReadyProbe({ fireDotLayerPresent: false, visibleIds: ['a'], renderedIds: [] }),
      ),
    ).toMatch(/not in the style/);
    expect(
      mapReadyProbeDefect(
        buildMapReadyProbe({ fireDotLayerPresent: true, visibleIds: [], renderedIds: [] }),
      ),
    ).toMatch(/no fire event/);
    expect(
      mapReadyProbeDefect(
        buildMapReadyProbe({ fireDotLayerPresent: true, visibleIds: ['a'], renderedIds: [] }),
      ),
    ).toMatch(/rendered 0 of 1/);
  });

  it('caps the missing list', () => {
    const ids = Array.from({ length: 50 }, (_, index) => `e${index}`);
    const probe = buildMapReadyProbe({
      fireDotLayerPresent: true,
      visibleIds: ids,
      renderedIds: [],
    });
    expect(probe.missing).toHaveLength(10);
    expect(probe.visibleFireEvents).toBe(50);
  });

  it('guards a probe read back from the page', () => {
    expect(isMapReadyProbe(null)).toBe(false);
    expect(isMapReadyProbe({ fireDotLayerPresent: true })).toBe(false);
    expect(
      isMapReadyProbe({
        fireDotLayerPresent: true,
        visibleFireEvents: 1,
        renderedFireDots: 1,
        missing: [],
      }),
    ).toBe(true);
  });
});
