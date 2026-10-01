import { describe, expect, it } from 'vitest';

import { OMM_BY_NORAD, OMM_NOAA20 } from './__fixtures__/celestrak-omm.js';
import { parseOmmBody, parseOmmEpoch } from './omm.js';
import { PASS_PLATFORMS } from './pass-platforms.js';

function mutated(patch: Record<string, unknown>): string {
  const [record] = JSON.parse(OMM_NOAA20) as [Record<string, unknown>];
  return JSON.stringify([{ ...record, ...patch }]);
}

describe('parseOmmBody', () => {
  it.each(PASS_PLATFORMS.map((p) => [p.id, p.noradId] as const))(
    'accepts the recorded CelesTrak body for %s',
    (_id, noradId) => {
      const parsed = parseOmmBody(OMM_BY_NORAD[noradId]!, noradId);
      expect(parsed.ok).toBe(true);
    },
  );

  it('reads the epoch as UTC, keeping the microseconds', () => {
    const parsed = parseOmmBody(OMM_NOAA20, 43013);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.record.epochMs).toBeCloseTo(Date.UTC(2026, 8, 30, 3, 59, 35) + 473.92, 3);
    expect(parsed.record.objectName).toBe('NOAA 20 (JPSS-1)');
  });

  it.each([
    ['another satellite', OMM_NOAA20, 37849, /expected 37849/],
    ['CelesTrak’s plain-text refusal', 'No GP data found', 43013, /not JSON/],
    ['an empty array', '[]', 43013, /one-record/],
    ['two records', `[${OMM_NOAA20.slice(1, -1)},${OMM_NOAA20.slice(1, -1)}]`, 43013, /one-record/],
    ['non-SGP4 elements', mutated({ EPHEMERIS_TYPE: 2 }), 43013, /EPHEMERIS_TYPE/],
    ['a missing field', mutated({ BSTAR: undefined }), 43013, /bstar/],
    ['a non-finite field', mutated({ MEAN_ANOMALY: 'NaN' }), 43013, /meanAnomaly/],
    ['a geostationary orbit', mutated({ MEAN_MOTION: 1.0027 }), 43013, /low-Earth/],
    ['an eccentric orbit', mutated({ ECCENTRICITY: 0.2 }), 43013, /near-circular/],
    ['a zoned epoch', mutated({ EPOCH: '2026-09-30T03:59:35+02:00' }), 43013, /EPOCH/],
    ['an impossible date', mutated({ EPOCH: '2026-02-31T00:00:00' }), 43013, /EPOCH/],
  ])('refuses %s', (_name, body, noradId, reason) => {
    const parsed = parseOmmBody(body, noradId);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });
});

describe('parseOmmEpoch', () => {
  it('parses a zone-less OMM epoch as UTC, whatever the host zone', () => {
    expect(parseOmmEpoch('2026-09-30T00:00:00')).toBe(Date.UTC(2026, 8, 30));
    expect(parseOmmEpoch('2026-09-30T00:00:00.5')).toBe(Date.UTC(2026, 8, 30) + 500);
    expect(parseOmmEpoch('2026-09-30')).toBeNull();
  });
});
