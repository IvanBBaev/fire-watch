import { SOURCE_IDS } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import {
  SOURCE_STALENESS_THRESHOLDS_MS,
  staleSources,
  type SourceStalenessThresholds,
} from './source-staleness.js';

const NOW_MS = Date.parse('2026-08-09T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

function armed(overrides: Partial<SourceStalenessThresholds>): SourceStalenessThresholds {
  return { ...SOURCE_STALENESS_THRESHOLDS_MS, ...overrides };
}

describe('staleSources (F4)', () => {
  it('ships every registry source unarmed, so nothing is ever reported stale', () => {
    expect(Object.keys(SOURCE_STALENESS_THRESHOLDS_MS).toSorted()).toEqual(
      [...SOURCE_IDS].toSorted(),
    );
    expect(Object.values(SOURCE_STALENESS_THRESHOLDS_MS).every((ms) => ms === null)).toBe(true);
    const ancient = SOURCE_IDS.map((sourceId) => ({
      sourceId,
      lastObservedAt: '2001-01-01T00:00:00Z',
    }));
    expect(staleSources(ancient, SOURCE_STALENESS_THRESHOLDS_MS, NOW_MS)).toEqual([]);
    const never = SOURCE_IDS.map((sourceId) => ({ sourceId, lastObservedAt: null }));
    expect(staleSources(never, SOURCE_STALENESS_THRESHOLDS_MS, NOW_MS)).toEqual([]);
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
