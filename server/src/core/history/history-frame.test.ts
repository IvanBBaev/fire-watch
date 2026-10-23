import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import type { HistoryDetectionRow } from '../ports/history-reader.js';
import {
  buildHistoryDocument,
  HISTORY_BUCKET_MS,
  HISTORY_RANGE_MS,
  HISTORY_RANGES,
  historyWindow,
  isHistoryRange,
  parseHistoryQuery,
  quantiseCoordinate,
} from './history-frame.js';

const NOW = epochMsFromIso('2026-08-09T10:17:42Z');

function row(overrides: Partial<HistoryDetectionRow> = {}): HistoryDetectionRow {
  return {
    uid: 'a'.repeat(64),
    sourceId: 'firms:viirs:noaa21',
    observedAt: epochMsFromIso('2026-08-09T01:02:00Z'),
    lon: 27.51634,
    lat: 41.97712,
    frpMw: 9.84,
    eventPublicId: 'fw-2026-b2n5c',
    ...overrides,
  };
}

describe('historyWindow', () => {
  it('aligns the end down to the ten-minute bucket and reaches back the range', () => {
    const window = historyWindow('24h', NOW);
    expect(window.toMs).toBe(epochMsFromIso('2026-08-09T10:10:00Z'));
    expect(window.fromMs).toBe(epochMsFromIso('2026-08-08T10:10:00Z'));
  });

  it('is the same window for every instant inside one bucket', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: HISTORY_BUCKET_MS - 1 }),
        fc.constantFrom(...HISTORY_RANGES),
        (offset, range) => {
          const start = epochMsFromIso('2026-08-09T10:10:00Z');
          const window = historyWindow(range, start + offset);
          expect(window.toMs).toBe(start);
          expect(window.toMs - window.fromMs).toBe(HISTORY_RANGE_MS[range]);
        },
      ),
    );
  });

  it('never reaches past seven days', () => {
    for (const range of HISTORY_RANGES) {
      expect(HISTORY_RANGE_MS[range]).toBeLessThanOrEqual(7 * 24 * 3_600_000);
    }
  });
});

describe('parseHistoryQuery', () => {
  it('accepts exactly one known range', () => {
    expect(parseHistoryQuery({ range: '3d' })).toEqual({ ok: true, range: '3d' });
    expect(isHistoryRange('7d')).toBe(true);
  });

  it.each([
    [{}, 'bad_range'],
    [{ range: '30d' }, 'bad_range'],
    [{ range: ['24h', '3d'] }, 'bad_range'],
    [{ range: '24h', cb: '1' }, 'unknown_parameter'],
    [{ from: '2026-08-01' }, 'unknown_parameter'],
  ])('refuses %j (%s)', (query, reason) => {
    expect(parseHistoryQuery(query)).toEqual({ ok: false, reason });
  });
});

describe('buildHistoryDocument', () => {
  const window = historyWindow('24h', NOW);
  const attribution = [{ id: 'nasa-firms', source: 'NASA FIRMS', text: 'NASA FIRMS' }];

  it('frames rows as columns in minutes from the window start, oldest first', () => {
    const doc = buildHistoryDocument({
      window,
      maxDetections: 10,
      attribution,
      rows: [
        row({ uid: 'b'.repeat(64), observedAt: window.fromMs + 90 * 60_000, frpMw: null }),
        row({
          uid: 'c'.repeat(64),
          observedAt: window.fromMs + 5 * 60_000,
          sourceId: 'firms:modis:aqua',
          eventPublicId: null,
          lon: -0.00012,
        }),
      ],
    });
    expect(doc).toMatchObject({
      schema_version: 1,
      range: '24h',
      window_from: '2026-08-08T10:10:00Z',
      window_to: '2026-08-09T10:10:00Z',
      generated_at: '2026-08-09T10:10:00Z',
      truncated: false,
      count: 2,
      sources: ['firms:modis:aqua', 'firms:viirs:noaa21'],
      events: ['fw-2026-b2n5c'],
      detections: {
        t: [5, 90],
        lon: [0, 27.516],
        lat: [41.977, 41.977],
        frp: [9.8, null],
        s: [0, 1],
        e: [-1, 0],
      },
    });
    expect(Object.is(doc.detections.lon[0], -0)).toBe(false);
  });

  it('keeps the newest rows past the bound and says so', () => {
    const rows = [1, 2, 3, 4].map((n) =>
      row({ uid: String(n).repeat(64), observedAt: window.fromMs + n * 60_000 }),
    );
    const doc = buildHistoryDocument({ window, rows, maxDetections: 3, attribution });
    expect(doc.truncated).toBe(true);
    expect(doc.detections.t).toEqual([2, 3, 4]);
  });

  it('drops rows outside the half-open window instead of trusting the reader', () => {
    const doc = buildHistoryDocument({
      window,
      maxDetections: 10,
      attribution,
      rows: [
        row({ observedAt: window.fromMs - 60_000 }),
        row({ observedAt: window.toMs }),
        row({ observedAt: window.fromMs }),
      ],
    });
    expect(doc.detections.t).toEqual([0]);
  });

  it('is deterministic whatever order the rows arrive in', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            minute: fc.integer({ min: 0, max: 24 * 60 - 1 }),
            uid: fc.stringMatching(/^[0-9a-f]{64}$/),
            frp: fc.option(fc.double({ min: 0, max: 5000, noNaN: true })),
          }),
          { maxLength: 30 },
        ),
        (specs) => {
          const rows = specs.map((spec) =>
            row({
              uid: spec.uid,
              observedAt: window.fromMs + spec.minute * 60_000,
              frpMw: spec.frp,
            }),
          );
          const a = buildHistoryDocument({ window, rows, maxDetections: 20, attribution });
          const b = buildHistoryDocument({
            window,
            rows: [...rows].reverse(),
            maxDetections: 20,
            attribution,
          });
          expect(JSON.stringify(a)).toBe(JSON.stringify(b));
          const t = a.detections.t;
          for (let index = 1; index < t.length; index += 1) {
            expect(t[index]).toBeGreaterThanOrEqual(t[index - 1] ?? 0);
          }
        },
      ),
    );
  });

  it('refuses a non-positive bound', () => {
    expect(() => buildHistoryDocument({ window, rows: [], maxDetections: 0, attribution })).toThrow(
      RangeError,
    );
  });

  it('quantises coordinates to three decimals', () => {
    expect(quantiseCoordinate(27.51651)).toBe(27.517);
    expect(quantiseCoordinate(-12.34449)).toBe(-12.344);
  });
});
