import { describe, expect, it } from 'vitest';

import { COVERED_AREA } from './coverage.js';
import { LOCATED_ZOOM, resolveLocateOutcome } from './locate.js';

describe('resolveLocateOutcome', () => {
  it('moves the camera to a fix inside coverage', () => {
    const outcome = resolveLocateOutcome({ kind: 'fix', lon: 23.3219, lat: 42.6977 });
    expect(outcome).toEqual({
      kind: 'moved',
      camera: { zoom: LOCATED_ZOOM, lat: 42.6977, lon: 23.3219 },
    });
  });

  it('keeps the cross-border band inside coverage — fires do not stop at the border', () => {
    // Thessaloniki: Greece, but well within the 100 km band we stand behind.
    expect(resolveLocateOutcome({ kind: 'fix', lon: 22.94, lat: 40.64 }).kind).toBe('moved');
  });

  it('refuses to move to a fix outside coverage instead of showing an empty map', () => {
    // Lisbon: a real fix, nothing polled there — an empty map would read as "no fires".
    expect(resolveLocateOutcome({ kind: 'fix', lon: -9.14, lat: 38.72 })).toEqual({
      kind: 'outsideCoverage',
    });
  });

  it('treats a point just past the covered edge as outside', () => {
    const justEast = COVERED_AREA.east + 0.01;
    expect(resolveLocateOutcome({ kind: 'fix', lon: justEast, lat: 42.7 })).toEqual({
      kind: 'outsideCoverage',
    });
  });

  it('passes refusal and failure through as distinct outcomes', () => {
    expect(resolveLocateOutcome({ kind: 'denied' })).toEqual({ kind: 'denied' });
    expect(resolveLocateOutcome({ kind: 'unavailable' })).toEqual({ kind: 'unavailable' });
  });

  it('frames a region rather than a rooftop', () => {
    expect(LOCATED_ZOOM).toBeGreaterThanOrEqual(8);
    expect(LOCATED_ZOOM).toBeLessThanOrEqual(11);
  });
});
