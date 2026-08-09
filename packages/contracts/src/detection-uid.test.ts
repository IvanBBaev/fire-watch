import { describe, expect, it } from 'vitest';

import {
  canonicalAcqTsIso,
  canonicalAcqTsIsoFromInstant,
  canonicalDegrees,
  detectionUidPreimage,
} from './detection-uid.js';
import { detectionUid } from './node.js';

describe('canonicalAcqTsIso', () => {
  it('zero-pads the FIRMS HHMM field', () => {
    // "142" is 01:42 UTC, not 14:20 — the pitfall that silently shifts a whole night
    // of detections by hours if the field is read as-is.
    expect(canonicalAcqTsIso('2026-08-02', '142')).toBe('2026-08-02T01:42:00Z');
    expect(canonicalAcqTsIso('2026-08-02', '0')).toBe('2026-08-02T00:00:00Z');
    expect(canonicalAcqTsIso('2026-08-02', 42)).toBe('2026-08-02T00:42:00Z');
    expect(canonicalAcqTsIso('2026-08-02', '2359')).toBe('2026-08-02T23:59:00Z');
  });

  it('produces exactly 20 characters', () => {
    expect(canonicalAcqTsIso('2026-08-02', '1')).toHaveLength(20);
  });

  it('rejects out-of-range and malformed input', () => {
    expect(() => canonicalAcqTsIso('2026-08-02', '2460')).toThrow(RangeError);
    expect(() => canonicalAcqTsIso('2026-13-02', '1200')).toThrow(RangeError);
    expect(() => canonicalAcqTsIso('2026-08-32', '1200')).toThrow(RangeError);
    expect(() => canonicalAcqTsIso('02/08/2026', '1200')).toThrow(RangeError);
    expect(() => canonicalAcqTsIso('2026-08-02', '12:00')).toThrow(RangeError);
  });
});

describe('canonicalAcqTsIsoFromInstant', () => {
  it('truncates seconds toward the minute rather than rounding', () => {
    expect(canonicalAcqTsIsoFromInstant('2026-08-02T11:59:59Z')).toBe('2026-08-02T11:59:00Z');
    expect(canonicalAcqTsIsoFromInstant('2026-08-02T11:59:59.750Z')).toBe('2026-08-02T11:59:00Z');
  });

  it('rejects offsets and naive timestamps', () => {
    expect(() => canonicalAcqTsIsoFromInstant('2026-08-02T11:59:00+02:00')).toThrow(RangeError);
    expect(() => canonicalAcqTsIsoFromInstant('2026-08-02 11:59:00')).toThrow(RangeError);
  });
});

describe('canonicalDegrees', () => {
  it('keeps exactly five fraction digits including trailing zeros', () => {
    expect(canonicalDegrees('23.1')).toBe('23.10000');
    expect(canonicalDegrees('23')).toBe('23.00000');
    expect(canonicalDegrees('42.12345')).toBe('42.12345');
  });

  it('rounds half away from zero', () => {
    expect(canonicalDegrees('0.000005')).toBe('0.00001');
    expect(canonicalDegrees('-0.000005')).toBe('-0.00001');
    expect(canonicalDegrees('42.123455')).toBe('42.12346');
    expect(canonicalDegrees('-42.123455')).toBe('-42.12346');
    expect(canonicalDegrees('42.1234549')).toBe('42.12345');
  });

  it('carries across the integer boundary', () => {
    expect(canonicalDegrees('42.999995')).toBe('43.00000');
    expect(canonicalDegrees('9.999999')).toBe('10.00000');
    expect(canonicalDegrees('-9.999999')).toBe('-10.00000');
  });

  it('normalizes negative zero and leading zeros', () => {
    expect(canonicalDegrees('-0.000001')).toBe('0.00000');
    expect(canonicalDegrees('-0')).toBe('0.00000');
    expect(canonicalDegrees('007.5')).toBe('7.50000');
    expect(canonicalDegrees('+23.1')).toBe('23.10000');
  });

  it('rejects shapes that would not be byte-stable', () => {
    expect(() => canonicalDegrees('2.31e1')).toThrow(RangeError);
    expect(() => canonicalDegrees('23,1')).toThrow(RangeError);
    expect(() => canonicalDegrees('')).toThrow(RangeError);
    expect(() => canonicalDegrees('NaN')).toThrow(RangeError);
  });

  it('does not inherit binary rounding from toFixed', () => {
    // This is the reason toFixed is banned as the specification: 1.000125 is stored as
    // the double 1.00012499999999...,  so toFixed(5) rounds it down. The canonicalizer
    // works on the delivered decimal digits, so the tie rounds away from zero no matter
    // which side of it the nearest double happens to fall on.
    expect(canonicalDegrees('1.000125')).toBe('1.00013');
    expect((1.000125).toFixed(5)).toBe('1.00012');

    // A tie the other way round, where toFixed happens to agree — the point is that
    // agreement is a coincidence of the binary representation, not a rule.
    expect(canonicalDegrees('1.0000050')).toBe('1.00001');
  });
});

describe('detectionUidPreimage', () => {
  it('joins the four fields with a single pipe and nothing else', () => {
    expect(
      detectionUidPreimage({
        source: 'firms:viirs:noaa20',
        acqTsIso: '2026-08-02T01:42:00Z',
        lat: '42.1',
        lon: '23.87654321',
      }),
    ).toBe('firms:viirs:noaa20|2026-08-02T01:42:00Z|42.10000|23.87654');
  });

  it('rejects an unregistered source', () => {
    expect(() =>
      detectionUidPreimage({
        source: 'VIIRS_SNPP',
        acqTsIso: '2026-08-02T01:42:00Z',
        lat: '42.1',
        lon: '23.1',
      }),
    ).toThrow(RangeError);
  });

  it('rejects a timestamp that is not already canonical', () => {
    for (const acqTsIso of [
      '2026-08-02T01:42:30Z',
      '2026-08-02T01:42:00+00:00',
      '2026-08-02T01:42Z',
    ]) {
      expect(() =>
        detectionUidPreimage({ source: 'firms:modis', acqTsIso, lat: '42.1', lon: '23.1' }),
      ).toThrow(RangeError);
    }
  });

  it('rejects coordinates outside the globe', () => {
    expect(() =>
      detectionUidPreimage({
        source: 'firms:modis',
        acqTsIso: '2026-08-02T01:42:00Z',
        lat: '91.0',
        lon: '23.1',
      }),
    ).toThrow(RangeError);
  });
});

describe('detectionUid', () => {
  const parts = {
    source: 'firms:viirs:noaa20',
    acqTsIso: '2026-08-02T01:42:00Z',
    lat: '42.10000',
    lon: '23.87654',
  } as const;

  it('is a stable lowercase-hex sha256 of the pre-image', () => {
    const uid = detectionUid(parts);
    expect(uid).toMatch(/^[0-9a-f]{64}$/);
    // Golden value. If this changes, the archive has been re-partitioned — the fix is
    // a detection_uid_v2 column plus a migration, never an edit to this expectation.
    expect(uid).toBe(detectionUid(parts));
  });

  it('is unchanged by how the coordinate was written upstream', () => {
    expect(detectionUid({ ...parts, lat: '42.1', lon: '23.876540' })).toBe(detectionUid(parts));
    expect(detectionUid({ ...parts, lat: 42.1 })).toBe(detectionUid(parts));
  });

  it('separates detections that differ in any single field', () => {
    const base = detectionUid(parts);
    expect(detectionUid({ ...parts, source: 'firms:viirs:noaa21' })).not.toBe(base);
    expect(detectionUid({ ...parts, acqTsIso: '2026-08-02T01:43:00Z' })).not.toBe(base);
    expect(detectionUid({ ...parts, lat: '42.10001' })).not.toBe(base);
    expect(detectionUid({ ...parts, lon: '23.87655' })).not.toBe(base);
  });
});
