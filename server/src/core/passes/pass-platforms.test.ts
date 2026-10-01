import { SOURCE_REGISTRY } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { PASS_TABLE } from '../lifecycle/static-pass-predictor.js';
import { PASS_PLATFORMS, platformByNoradId, platformSwathKm } from './pass-platforms.js';

describe('pass platforms', () => {
  it('lists only platforms behind an active source', () => {
    for (const platform of PASS_PLATFORMS) {
      expect(SOURCE_REGISTRY[platform.source].status).toBe('active');
    }
  });

  it('takes each swath from pass_table_v0 rather than restating it', () => {
    for (const platform of PASS_PLATFORMS) {
      const row = PASS_TABLE.values.sources.find((r) => r.source === platform.source)!;
      const sharing = PASS_PLATFORMS.filter((p) => p.source === platform.source).length;
      // SLSTR's row folds S3A and S3B into one source; every VIIRS row is one satellite.
      expect(platform.swathKm * sharing).toBe(row.effectiveSwathKm);
    }
    expect(platformSwathKm('firms:viirs:noaa20')).toBe(3060);
    expect(platformSwathKm('eumetsat:slstr:frp')).toBe(1420);
  });

  it('has unique catalogue numbers', () => {
    const ids = PASS_PLATFORMS.map((p) => p.noradId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(platformByNoradId(41335)?.id).toBe('s3a');
    expect(platformByNoradId(1)).toBeUndefined();
  });
});
