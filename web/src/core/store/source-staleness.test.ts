import { SOURCE_IDS } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import {
  SOURCE_STALENESS_THRESHOLDS_MS,
  VIIRS_SOURCE_IDS,
  VIIRS_STALE_AFTER_MS,
  staleSources,
  viirsQuietSince,
  type SourceStalenessThresholds,
} from './source-staleness.js';

const NOW_MS = Date.parse('2026-08-09T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

const ALL_UNARMED = Object.fromEntries(SOURCE_IDS.map((id) => [id, null])) as Record<
  string,
  null
> as SourceStalenessThresholds;

/** The selector's own contract, independent of what ships armed. */
function armed(overrides: Partial<SourceStalenessThresholds>): SourceStalenessThresholds {
  return { ...ALL_UNARMED, ...overrides };
}

describe('staleSources (F4)', () => {
  it('ships VIIRS armed at 36 h and every other registry source unarmed (F4-a)', () => {
    expect(Object.keys(SOURCE_STALENESS_THRESHOLDS_MS).toSorted()).toEqual(
      [...SOURCE_IDS].toSorted(),
    );
    expect(VIIRS_STALE_AFTER_MS).toBe(36 * HOUR_MS);
    const armedIds = SOURCE_IDS.filter((id) => SOURCE_STALENESS_THRESHOLDS_MS[id] !== null);
    expect(armedIds).toEqual([...VIIRS_SOURCE_IDS]);
    for (const id of VIIRS_SOURCE_IDS) {
      expect(SOURCE_STALENESS_THRESHOLDS_MS[id]).toBe(VIIRS_STALE_AFTER_MS);
    }
    const ancient = SOURCE_IDS.map((sourceId) => ({
      sourceId,
      lastObservedAt: '2001-01-01T00:00:00Z',
    }));
    expect(
      staleSources(ancient, SOURCE_STALENESS_THRESHOLDS_MS, NOW_MS).map((row) => row.sourceId),
    ).toEqual([...VIIRS_SOURCE_IDS]);
  });

  it('reports an armed source strictly past its threshold, with its server-time age', () => {
    const thresholds = armed({ 'firms:viirs:snpp': 6 * HOUR_MS });
    const at = (hoursAgo: number) => new Date(NOW_MS - hoursAgo * HOUR_MS).toISOString();

    expect(
      staleSources([{ sourceId: 'firms:viirs:snpp', lastObservedAt: at(6) }], thresholds, NOW_MS),
    ).toEqual([]);
    expect(
      staleSources([{ sourceId: 'firms:viirs:snpp', lastObservedAt: at(7) }], thresholds, NOW_MS),
    ).toEqual([
      {
        sourceId: 'firms:viirs:snpp',
        lastObservedAt: at(7),
        ageMs: 7 * HOUR_MS,
        thresholdMs: 6 * HOUR_MS,
      },
    ]);
  });

  it('treats an armed source that was never observed as stale', () => {
    const thresholds = armed({ 'firms:modis': HOUR_MS });
    expect(
      staleSources([{ sourceId: 'firms:modis', lastObservedAt: null }], thresholds, NOW_MS),
    ).toEqual([
      { sourceId: 'firms:modis', lastObservedAt: null, ageMs: null, thresholdMs: HOUR_MS },
    ]);
  });

  it('skips unarmed sources, unknown ids, garbage instants and future instants', () => {
    const thresholds = armed({ 'firms:viirs:snpp': HOUR_MS });
    const old = '2026-08-08T00:00:00Z';
    expect(
      staleSources(
        [
          { sourceId: 'firms:viirs:noaa20', lastObservedAt: old },
          { sourceId: 'firms-viirs-snpp', lastObservedAt: old },
          { sourceId: 'firms:viirs:snpp', lastObservedAt: 'yesterday' },
        ],
        thresholds,
        NOW_MS,
      ),
    ).toEqual([]);
    expect(
      staleSources(
        [{ sourceId: 'firms:viirs:snpp', lastObservedAt: '2026-08-09T13:00:00Z' }],
        thresholds,
        NOW_MS,
      ),
    ).toEqual([]);
  });

  it('keeps the order of the rows it was given', () => {
    const thresholds = armed({ 'firms:modis': HOUR_MS, 'firms:viirs:snpp': HOUR_MS });
    const old = '2026-08-08T00:00:00Z';
    const ids = staleSources(
      [
        { sourceId: 'firms:modis', lastObservedAt: old },
        { sourceId: 'firms:viirs:snpp', lastObservedAt: old },
      ],
      thresholds,
      NOW_MS,
    ).map((row) => row.sourceId);
    expect(ids).toEqual(['firms:modis', 'firms:viirs:snpp']);
  });
});

describe('viirsQuietSince (F4-b)', () => {
  const at = (hoursAgo: number) => new Date(NOW_MS - hoursAgo * HOUR_MS).toISOString();
  const rows = (...hoursAgo: (number | null)[]) =>
    VIIRS_SOURCE_IDS.map((sourceId, index) => ({
      sourceId,
      lastObservedAt: hoursAgo[index] == null ? null : at(hoursAgo[index]),
    }));

  it('cites the newest VIIRS detection once every VIIRS row is past 36 h', () => {
    expect(viirsQuietSince(rows(40, 37, 50), SOURCE_STALENESS_THRESHOLDS_MS, NOW_MS)).toBe(at(37));
  });

  it('stays quiet while any one satellite is inside its threshold', () => {
    expect(viirsQuietSince(rows(40, 36, 50), SOURCE_STALENESS_THRESHOLDS_MS, NOW_MS)).toBeNull();
    expect(viirsQuietSince(rows(40, 2, 50), SOURCE_STALENESS_THRESHOLDS_MS, NOW_MS)).toBeNull();
  });

  it('skips a never-observed sibling for the age but still needs it stale', () => {
    expect(viirsQuietSince(rows(40, null, 50), SOURCE_STALENESS_THRESHOLDS_MS, NOW_MS)).toBe(
      at(40),
    );
    expect(
      viirsQuietSince(rows(null, null, null), SOURCE_STALENESS_THRESHOLDS_MS, NOW_MS),
    ).toBeNull();
  });

  it('renders no note before a snapshot carried any VIIRS row, or from a garbage instant', () => {
    expect(viirsQuietSince([], SOURCE_STALENESS_THRESHOLDS_MS, NOW_MS)).toBeNull();
    expect(
      viirsQuietSince(
        [{ sourceId: 'firms:modis', lastObservedAt: at(100) }],
        SOURCE_STALENESS_THRESHOLDS_MS,
        NOW_MS,
      ),
    ).toBeNull();
    expect(
      viirsQuietSince(
        [...rows(40, 40), { sourceId: 'firms:viirs:noaa21', lastObservedAt: 'yesterday' }],
        SOURCE_STALENESS_THRESHOLDS_MS,
        NOW_MS,
      ),
    ).toBeNull();
  });
});
