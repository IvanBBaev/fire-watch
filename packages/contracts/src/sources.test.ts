import { describe, expect, it } from 'vitest';

import { MONITORED_SOURCE_IDS } from './freshness.js';
import {
  LIVE_SOURCE_IDS,
  RESERVED_SOURCE_IDS,
  SOURCE_IDS,
  SOURCE_REGISTRY,
  SOURCE_REGISTRY_VERSION,
  activeSources,
  expectedOverpassSources,
  isLiveSourceId,
} from './sources.js';

describe('source_registry_v2 reserved ids (V3-P4)', () => {
  it('bumps the registry version for the appended rows', () => {
    expect(SOURCE_REGISTRY_VERSION).toBe('source_registry_v2');
  });

  it('appends the three v3 ids after the frozen v1 rows', () => {
    // Rule 1: append-only. The v1 rows keep their positions; v2 only adds.
    expect(SOURCE_IDS.slice(0, 7)).toEqual([
      'firms:viirs:snpp',
      'firms:viirs:noaa20',
      'firms:viirs:noaa21',
      'firms:modis',
      'eumetsat:slstr:frp',
      'lsasaf:seviri:frp-pixel',
      'lsasaf:fci:frp-pixel',
    ]);
    expect(SOURCE_IDS.slice(7)).toEqual(['efa:firesat', 'firms:landsat', 'ororatech:frp']);
  });

  it('marks exactly the reserved ids as reserved in the registry', () => {
    const reserved = SOURCE_IDS.filter((id) => SOURCE_REGISTRY[id].status === 'reserved');
    expect(reserved).toEqual([...RESERVED_SOURCE_IDS]);
  });

  it('keeps reserved ids out of every polled, expected and monitored set', () => {
    const active = activeSources().map((entry) => entry.id);
    const expected = expectedOverpassSources().map((entry) => entry.id);
    for (const id of RESERVED_SOURCE_IDS) {
      expect(active).not.toContain(id);
      expect(expected).not.toContain(id);
      expect(MONITORED_SOURCE_IDS).not.toContain(id);
      expect(isLiveSourceId(id)).toBe(false);
    }
  });

  it('partitions the registry into live and reserved ids', () => {
    expect([...LIVE_SOURCE_IDS, ...RESERVED_SOURCE_IDS].toSorted()).toEqual(
      [...SOURCE_IDS].toSorted(),
    );
    for (const id of LIVE_SOURCE_IDS) expect(isLiveSourceId(id)).toBe(true);
    expect(isLiveSourceId('not:a:source')).toBe(false);
  });

  it('registers Landsat as attach-only confirmation and SLSTR under its v1 id', () => {
    expect(SOURCE_REGISTRY['firms:landsat'].attachOnly).toBe(true);
    expect(SOURCE_REGISTRY['eumetsat:slstr:frp'].status).toBe('active');
  });
});
