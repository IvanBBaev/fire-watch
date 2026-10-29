import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FIRESAT_CONFIDENCE,
  FIRESAT_SOURCE,
  FiresatFormatError,
  firesatConfidence,
  parseFiresatDocument,
} from './firesat-format.js';

const SAMPLE = readFileSync(
  join(import.meta.dirname, '__fixtures__/firesat-balkans-sample.json'),
  'utf8',
);

function document(detections: unknown[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'firesat-detections',
    format_version: '0-provisional',
    product: 'FIRESAT_NRT',
    detections,
    ...overrides,
  });
}

describe('firesat confidence', () => {
  it('classes a probability by the v0 cut points', () => {
    expect(FIRESAT_CONFIDENCE.version).toBe('firesat_confidence_v0');
    expect(firesatConfidence(0)).toBe('low');
    expect(firesatConfidence(0.299)).toBe('low');
    expect(firesatConfidence(0.3)).toBe('nominal');
    expect(firesatConfidence(0.799)).toBe('nominal');
    expect(firesatConfidence(0.8)).toBe('high');
    expect(firesatConfidence(1)).toBe('high');
  });

  it('refuses a value outside [0, 1]', () => {
    expect(() => firesatConfidence(1.01)).toThrow(RangeError);
    expect(() => firesatConfidence(-0.1)).toThrow(RangeError);
    expect(() => firesatConfidence(Number.NaN)).toThrow(RangeError);
  });
});

describe('parseFiresatDocument', () => {
  it('reads the sample into rows attributed to the registry source', () => {
    const result = parseFiresatDocument(SAMPLE);
    expect(result.source).toBe(FIRESAT_SOURCE);
    expect(result.rows).toHaveLength(4);
    expect(result.rejections).toHaveLength(1);

    const [first, second, third] = result.rows;
    expect(first).toMatchObject({
      rowIndex: 1,
      source: 'efa:firesat',
      acqTsIso: '2026-08-02T10:41:00Z',
      latCanonical: '41.85012',
      lonCanonical: '26.14003',
      confidence: 'high',
      confidenceRaw: '0.93',
      frpMw: 14.2,
      dayNight: 'D',
      scanKm: 0.082,
      trackKm: 0.079,
      brightnessK: 342.1,
      brightnessSecondaryK: 301.7,
      satelliteRaw: 'FIRESAT2',
      instrumentRaw: 'FireSat',
      versionRaw: '0.9.1',
    });
    // Numeric coordinates, an unreported FRP and a missing LWIR read as such.
    expect(second).toMatchObject({
      latCanonical: '42.10234',
      lonCanonical: '23.40581',
      confidence: 'nominal',
      frpMw: null,
      brightnessSecondaryK: null,
    });
    // A reported zero stays zero (FIRMS pitfall 9).
    expect(third).toMatchObject({ frpMw: 0, confidence: 'low', dayNight: 'N' });
  });

  it('turns a detection it cannot read into a rejection carrying its bytes', () => {
    const { rejections } = parseFiresatDocument(SAMPLE);
    expect(rejections[0]).toMatchObject({ rowIndex: 5 });
    expect(rejections[0]!.reason).toMatch(/pixel_along_track_m/);
    expect(JSON.parse(rejections[0]!.raw)).toMatchObject({ satellite: 'FIRESAT3' });
  });

  it.each([
    ['a missing probability', { detection_probability: undefined }, /detection_probability/],
    ['a probability above 1', { detection_probability: 1.2 }, /\[0, 1\]/],
    ['a zero footprint', { pixel_along_scan_m: 0 }, /pixel_along_scan_m/],
    ['an out-of-range latitude', { latitude: 91 }, /./],
    ['a bad day/night flag', { day_night: 'X' }, /day_night/],
    ['a non-numeric FRP', { frp_mw: '3' }, /frp_mw/],
    ['a missing time', { acquired_at: '' }, /acquired_at/],
  ])('rejects %s', (_label, override, reason) => {
    const base = (JSON.parse(SAMPLE) as { detections: Record<string, unknown>[] }).detections[0];
    const result = parseFiresatDocument(document([{ ...base, ...override }, 'not an object']));
    expect(result.rows).toHaveLength(0);
    expect(result.rejections).toHaveLength(2);
    expect(result.rejections[0]!.reason).toMatch(reason);
    expect(result.rejections[1]!.reason).toMatch(/JSON object/);
  });

  it.each([
    ['not JSON', 'Service Unavailable'],
    ['not an object', '[]'],
    ['another format', document([], { format: 'firms-csv' })],
    ['another version', document([], { format_version: '1' })],
    ['another product', document([], { product: 'FIRESAT_SP' })],
    ['no detections array', document([], { detections: {} })],
  ])('refuses a document that is %s, whole', (_label, text) => {
    expect(() => parseFiresatDocument(text)).toThrow(FiresatFormatError);
  });

  it('reads an empty detection list as a successful empty batch', () => {
    expect(parseFiresatDocument(document([]))).toMatchObject({ rows: [], rejections: [] });
  });
});
