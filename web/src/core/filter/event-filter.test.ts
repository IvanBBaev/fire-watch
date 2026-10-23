import { describe, expect, it } from 'vitest';

import type { RegionLookup } from './event-filter.js';
import { SENSITIVITY_PRESETS } from './sensitivity.js';
import {
  countFamilies,
  countSensitivity,
  familiesOf,
  matchesFilter,
  partitionEvents,
  scopePredicate,
} from './event-filter.js';

const NOW = Date.parse('2026-08-09T12:00:00Z');
const HOUR = 3_600_000;

function ev(
  id: string,
  hoursAgo: number,
  lon: number,
  sourceIds?: readonly string[],
): { id: string; lat: number; lon: number; lastObservedAt: string; sourceIds?: readonly string[] } {
  return {
    id,
    lat: 42,
    lon,
    lastObservedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    ...(sourceIds === undefined ? {} : { sourceIds }),
  };
}

// Oblast = the integer part of the longitude; west of 1 is outside Bulgaria.
const regionAt: RegionLookup = (lon) => (lon >= 1 ? Math.floor(lon) : null);

const VIIRS = ['firms:viirs:noaa20'];
const MODIS = ['firms:modis'];
const BOTH = [...VIIRS, ...MODIS];

const EVENTS = [
  ev('a', 1, 5.5, VIIRS),
  ev('b', 2, 6.5, MODIS),
  ev('c', 3, 5.5, BOTH),
  ev('d', 30, 5.5, VIIRS),
  ev('e', 1, 5.5),
  ev('f', 1, 0.5, VIIRS),
];

describe('partitionEvents', () => {
  it('splits by why a row is hidden, in input order', () => {
    const cutoffMs = NOW - 24 * HOUR;
    const all = partitionEvents(EVENTS, { cutoffMs, family: null, oblast: null }, regionAt);
    expect(all.visible.map((e) => e.id)).toStrictEqual(['a', 'b', 'c', 'e', 'f']);
    expect(all).toMatchObject({ olderCount: 1, filteredCount: 0 });

    const viirsIn5 = partitionEvents(EVENTS, { cutoffMs, family: 'v', oblast: 5 }, regionAt);
    // `e` has no sources reported: it passes the source filter rather than vanish.
    expect(viirsIn5.visible.map((e) => e.id)).toStrictEqual(['a', 'c', 'e']);
    expect(viirsIn5).toMatchObject({ olderCount: 1, filteredCount: 2 });
  });

  it('counts a row failing both window and scope as filtered, not older', () => {
    const p = partitionEvents(
      EVENTS,
      { cutoffMs: NOW - 24 * HOUR, family: 'm', oblast: null },
      regionAt,
    );
    expect(p.visible.map((e) => e.id)).toStrictEqual(['b', 'c', 'e']);
    expect(p.olderCount).toBe(0);
    expect(p.filteredCount).toBe(3);
  });

  it('fails the region filter open while the polygons are loading', () => {
    const p = partitionEvents(EVENTS, { cutoffMs: null, family: null, oblast: 6 }, null);
    expect(p.visible).toHaveLength(EVENTS.length);
    expect(scopePredicate({ family: null, oblast: 6 }, null)).toBeNull();
  });
});

describe('scopePredicate', () => {
  it('is null when only the window is set, so the map needs no predicate', () => {
    expect(scopePredicate({ family: null, oblast: null }, regionAt)).toBeNull();
  });

  it('agrees with matchesFilter for the scope half', () => {
    const predicate = scopePredicate({ family: 'v', oblast: 5 }, regionAt)!;
    for (const event of EVENTS) {
      expect(predicate(event), event.id).toBe(
        matchesFilter(event, { cutoffMs: null, family: 'v', oblast: 5 }, regionAt),
      );
    }
  });
});

describe('countFamilies', () => {
  it('counts over window and region, an event under every family that saw it', () => {
    const counts = countFamilies(EVENTS, { cutoffMs: NOW - 24 * HOUR, oblast: 5 }, regionAt);
    expect(counts.byFamily).toStrictEqual({ v: 2, m: 1, s: 0, g: 0 });
    expect(counts.unreported).toBe(1);
    expect(counts.total).toBe(3);
  });
});

describe('events whose sources this build cannot place (F12)', () => {
  const cutoff = { cutoffMs: null, oblast: null } as const;
  const UNKNOWN = ev('u', 1, 5.5, ['future:sensor:x']);
  const EMPTY = ev('z', 1, 5.5, []);
  const MIXED = ev('x', 1, 5.5, ['future:sensor:x', 'eumetsat:slstr:frp']);

  it('treats only-unknown and empty id lists as unreported: counted so, and passing every family', () => {
    const counts = countFamilies([UNKNOWN, EMPTY, MIXED], cutoff, regionAt);
    expect(counts.unreported).toBe(2);
    expect(counts.byFamily).toStrictEqual({ v: 0, m: 0, s: 1, g: 0 });
    for (const family of ['v', 'm', 's', 'g'] as const) {
      expect(matchesFilter(UNKNOWN, { ...cutoff, family }, regionAt)).toBe(true);
      expect(matchesFilter(EMPTY, { ...cutoff, family }, regionAt)).toBe(true);
    }
  });

  it('places a mixed event by its known ids alone', () => {
    expect(familiesOf(MIXED)).toStrictEqual(new Set(['s']));
    expect(matchesFilter(MIXED, { ...cutoff, family: 's' }, regionAt)).toBe(true);
    expect(matchesFilter(MIXED, { ...cutoff, family: 'v' }, regionAt)).toBe(false);
  });

  it('reads the served shape: every registered sensor lands in its family', () => {
    const served = ev('all', 1, 5.5, [
      'eumetsat:slstr:frp',
      'firms:modis',
      'firms:viirs:noaa20',
      'firms:viirs:noaa21',
      'firms:viirs:snpp',
      'lsasaf:fci:frp-pixel',
      'lsasaf:seviri:frp-pixel',
    ]);
    expect(familiesOf(served)).toStrictEqual(new Set(['v', 'm', 's', 'g']));
    expect(familiesOf(ev('none', 1, 5.5))).toBeNull();
  });
});

describe('the sensitivity filter in the shared rule (V2-A2)', () => {
  const strong = { ...ev('s', 1, 5.5, BOTH), scoreBucket: 'confirmed', detectionCount: 4 } as const;
  const likelyOnce = {
    ...ev('l', 1, 5.5, VIIRS),
    scoreBucket: 'likely',
    detectionCount: 1,
  } as const;
  const weak = { ...ev('w', 1, 5.5, VIIRS), scoreBucket: 'unverified', detectionCount: 1 } as const;
  const legacy = ev('legacy', 1, 5.5); // a cached body with none of the fields
  const old = { ...ev('o', 30, 5.5, VIIRS), scoreBucket: 'unverified', detectionCount: 1 } as const;
  const items = [strong, likelyOnce, weak, legacy, old];

  it('counts what it hides as filtered, never as older', () => {
    const p = partitionEvents(
      items,
      {
        cutoffMs: NOW - 24 * HOUR,
        family: null,
        oblast: null,
        sensitivity: SENSITIVITY_PRESETS.balanced,
      },
      regionAt,
    );
    expect(p.visible.map((e) => e.id)).toEqual(['s', 'legacy']);
    expect(p.filteredCount).toBe(3);
    expect(p.olderCount).toBe(0);
  });

  it('gives the map a predicate only when a non-default sensitivity is set', () => {
    expect(
      scopePredicate(
        { family: null, oblast: null, sensitivity: SENSITIVITY_PRESETS.all },
        regionAt,
      ),
    ).toBeNull();
    const predicate = scopePredicate(
      { family: null, oblast: null, sensitivity: SENSITIVITY_PRESETS.multi },
      regionAt,
    )!;
    expect(items.filter(predicate).map((e) => e.id)).toEqual(['s', 'legacy']);
  });

  it('counts each preset over the other filters, and the blind sensor passes', () => {
    const counts = countSensitivity(
      items,
      {
        cutoffMs: NOW - 24 * HOUR,
        family: 'v',
        oblast: 5,
        sensitivity: SENSITIVITY_PRESETS.multi,
      },
      regionAt,
    );
    expect(counts.byPreset).toStrictEqual({ all: 4, balanced: 2, multi: 2 });
    expect(counts.current).toBe(2);
    expect(counts.sensorsUnreported).toBe(1);
  });

  it('narrows the sensor counts too', () => {
    const counts = countFamilies(
      items,
      { cutoffMs: null, oblast: null, sensitivity: SENSITIVITY_PRESETS.balanced },
      regionAt,
    );
    expect(counts.total).toBe(2);
    expect(counts.byFamily.v).toBe(1);
    expect(counts.unreported).toBe(1);
  });
});
