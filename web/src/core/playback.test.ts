import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  PLAYBACK_AGE_CLASSES,
  PLAYBACK_SPEEDS,
  nextSpeed,
  parseHistoryBody,
  playbackAgeClass,
  playbackCollection,
  playbackTickMs,
  shownCount,
  stepCursor,
} from './history-body.js';
import {
  HISTORY_RANGE_MINUTES,
  HISTORY_RANGES,
  clampCursor,
  cursorForInstant,
  cursorInstantMs,
  formatPlaybackParam,
  parsePlaybackParam,
  type HistoryBody,
} from './playback.js';

function body(overrides: Partial<Record<keyof HistoryBody, unknown>> = {}): unknown {
  return {
    schema_version: 1,
    range: '24h',
    window_from: '2026-08-08T10:10:00Z',
    window_to: '2026-08-09T10:10:00Z',
    generated_at: '2026-08-09T10:10:00Z',
    truncated: false,
    count: 3,
    sources: ['firms:modis:aqua', 'firms:viirs:noaa21'],
    events: ['fw-2026-b2n5c'],
    detections: {
      t: [5, 90, 90],
      lon: [25.1, 25.11, 25.12],
      lat: [42.6, 42.61, 42.62],
      frp: [9.8, null, 120],
      s: [0, 1, 1],
      e: [-1, 0, 0],
    },
    attribution: [{ id: 'nasa-firms', source: 'NASA FIRMS', text: 'NASA FIRMS' }],
    ...overrides,
  };
}

describe('parseHistoryBody', () => {
  it('accepts the server document', () => {
    const parsed = parseHistoryBody(body());
    expect(parsed?.count).toBe(3);
    expect(parsed?.range).toBe('24h');
  });

  it('accepts an empty window', () => {
    const parsed = parseHistoryBody(
      body({
        count: 0,
        sources: [],
        events: [],
        detections: { t: [], lon: [], lat: [], frp: [], s: [], e: [] },
      }),
    );
    expect(parsed?.count).toBe(0);
  });

  it.each([
    ['a wrong schema', { schema_version: 2 }],
    ['an unknown range', { range: '30d' }],
    ['a window that is not the range', { window_to: '2026-08-09T11:10:00Z' }],
    ['an unreadable instant', { generated_at: 'yesterday' }],
    ['a count that disagrees', { count: 2 }],
    ['a missing truncation flag', { truncated: 'no' }],
    ['malformed attribution', { attribution: [{ id: 1 }] }],
    [
      'columns of different lengths',
      { detections: { t: [5], lon: [25, 26], lat: [42], frp: [null], s: [0], e: [-1] } },
    ],
    [
      'a minute outside the window',
      { count: 1, detections: { t: [1440], lon: [25], lat: [42], frp: [null], s: [0], e: [-1] } },
    ],
    [
      'unsorted minutes',
      {
        count: 2,
        detections: {
          t: [9, 5],
          lon: [25, 25],
          lat: [42, 42],
          frp: [null, null],
          s: [0, 0],
          e: [-1, -1],
        },
      },
    ],
    [
      'a source index past the list',
      { count: 1, detections: { t: [5], lon: [25], lat: [42], frp: [null], s: [2], e: [-1] } },
    ],
    [
      'an event index past the list',
      { count: 1, detections: { t: [5], lon: [25], lat: [42], frp: [null], s: [0], e: [1] } },
    ],
    [
      'a negative FRP',
      { count: 1, detections: { t: [5], lon: [25], lat: [42], frp: [-1], s: [0], e: [-1] } },
    ],
    [
      'a latitude off the globe',
      { count: 1, detections: { t: [5], lon: [25], lat: [95], frp: [null], s: [0], e: [-1] } },
    ],
  ])('refuses %s', (_label, overrides) => {
    expect(parseHistoryBody(body(overrides))).toBeNull();
  });

  it('never throws, whatever arrives', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => parseHistoryBody(value)).not.toThrow();
      }),
    );
  });
});

describe('the cursor', () => {
  it('clamps into the window and rounds to whole minutes', () => {
    expect(clampCursor(-5, '24h')).toBe(0);
    expect(clampCursor(99_999, '3d')).toBe(HISTORY_RANGE_MINUTES['3d']);
    expect(clampCursor(12.6, '24h')).toBe(13);
    expect(clampCursor(Number.NaN, '7d')).toBe(HISTORY_RANGE_MINUTES['7d']);
  });

  it('steps along the grid and stops at both ends', () => {
    expect(stepCursor(0, 1, '24h')).toBe(15);
    expect(stepCursor(7, 1, '24h')).toBe(15);
    expect(stepCursor(7, -1, '24h')).toBe(0);
    expect(stepCursor(0, -1, '24h')).toBe(0);
    expect(stepCursor(1440, 1, '24h')).toBe(1440);
    expect(stepCursor(1440, -1, '24h')).toBe(1425);
    expect(stepCursor(100, 1, '7d')).toBe(120);
  });

  it('stays inside the window for every step', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HISTORY_RANGES),
        fc.integer({ min: 0, max: 10_080 }),
        fc.constantFrom(-1 as const, 1 as const),
        (range, cursor, direction) => {
          const next = stepCursor(cursor, direction, range);
          expect(next).toBeGreaterThanOrEqual(0);
          expect(next).toBeLessThanOrEqual(HISTORY_RANGE_MINUTES[range]);
        },
      ),
    );
  });

  it('maps instants to cursors and back within the window', () => {
    const parsed = parseHistoryBody(body());
    if (parsed === null) throw new Error('fixture');
    const at = Date.parse('2026-08-08T12:40:00Z');
    expect(cursorForInstant(parsed, at)).toBe(150);
    expect(cursorInstantMs(parsed, 150)).toBe(at);
    expect(cursorForInstant(parsed, Date.parse('2020-01-01T00:00:00Z'))).toBe(0);
    expect(cursorForInstant(parsed, Date.parse('2030-01-01T00:00:00Z'))).toBe(1440);
  });

  it('counts what the cursor reveals', () => {
    const parsed = parseHistoryBody(body());
    if (parsed === null) throw new Error('fixture');
    expect(shownCount(parsed, 0)).toBe(0);
    expect(shownCount(parsed, 5)).toBe(1);
    expect(shownCount(parsed, 89)).toBe(1);
    expect(shownCount(parsed, 90)).toBe(3);
    expect(shownCount(parsed, 1440)).toBe(3);
  });

  it('cycles the speeds and shortens the tick', () => {
    expect(PLAYBACK_SPEEDS.map(nextSpeed)).toEqual([2, 4, 1]);
    expect(playbackTickMs(4)).toBeLessThan(playbackTickMs(1));
  });
});

describe('age classes', () => {
  it('runs newest to oldest, ending with an open class', () => {
    expect(playbackAgeClass(0)).toBe(0);
    expect(playbackAgeClass(59)).toBe(0);
    expect(playbackAgeClass(60)).toBe(1);
    expect(playbackAgeClass(359)).toBe(1);
    expect(playbackAgeClass(360)).toBe(2);
    expect(playbackAgeClass(1439)).toBe(2);
    expect(playbackAgeClass(1440)).toBe(3);
    expect(playbackAgeClass(10_000)).toBe(3);
    expect(PLAYBACK_AGE_CLASSES.at(-1)?.upperMinutes).toBeNull();
  });

  it('fades with age', () => {
    const opacities = PLAYBACK_AGE_CLASSES.map((entry) => entry.opacity);
    expect([...opacities].sort((a, b) => b - a)).toEqual(opacities);
  });
});

describe('pb= member', () => {
  it('reads a bare range and a pinned instant', () => {
    expect(parsePlaybackParam('3d')).toEqual({ range: '3d', atMs: null });
    expect(parsePlaybackParam('24h@202608081240')).toEqual({
      range: '24h',
      atMs: Date.parse('2026-08-08T12:40:00Z'),
    });
  });

  it.each([
    null,
    '',
    '30d',
    '24h@',
    '24h@2026080812',
    '24h@202602301200',
    '24h@202608082460',
    '7d@x',
  ])('refuses %j', (raw) => {
    expect(parsePlaybackParam(raw)).toBeNull();
  });

  it('round-trips', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HISTORY_RANGES),
        fc.option(fc.integer({ min: 0, max: 4_102_444_800_000 / 60_000 })),
        (range, minutes) => {
          const link = { range, atMs: minutes === null ? null : minutes * 60_000 };
          expect(parsePlaybackParam(formatPlaybackParam(link))).toEqual(link);
        },
      ),
    );
  });
});

describe('playbackCollection', () => {
  it('turns the columns into points, oldest first, keeping t, FRP and the event index', () => {
    const parsed = parseHistoryBody(body());
    if (parsed === null) throw new Error('fixture');
    const collection = playbackCollection(parsed);
    expect(collection.features).toHaveLength(3);
    expect(collection.features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [25.1, 42.6] },
      properties: { t: 5, frp: 9.8, e: -1 },
    });
    expect(collection.features[1]?.properties.frp).toBeNull();
  });
});
