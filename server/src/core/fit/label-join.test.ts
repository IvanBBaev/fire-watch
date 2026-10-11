import {
  canonicalAcqTsIsoFromInstant,
  canonicalDegrees,
  type SourceId,
} from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { epochMsFromIso } from '../ports/clock.js';
import { FIT_PARAMS } from './fit-params.js';
import {
  labelDetections,
  summarizeLabels,
  type FitDetection,
  type LabelPerimeter,
  type LonLat,
} from './label-join.js';

const box = (lon0: number, lon1: number): LonLat[] => [
  [lon0, 42.7],
  [lon1, 42.7],
  [lon1, 42.8],
  [lon0, 42.8],
  [lon0, 42.7],
];

const START = epochMsFromIso('2021-07-10T00:00:00Z');
const END = epochMsFromIso('2021-07-12T00:00:00Z');
const P1: LabelPerimeter = {
  fireId: '2021/p1',
  startMs: START,
  endMs: END,
  areaHa: 30,
  rings: [box(23.0, 23.1)],
};
const P2: LabelPerimeter = {
  fireId: '2021/p2',
  startMs: START,
  endMs: END,
  areaHa: 200,
  rings: [box(23.09, 23.2)],
};

let n = 0;
function det(
  lon: number,
  at = '2021-07-11T12:00:00Z',
  source: SourceId = 'firms:viirs:snpp',
): FitDetection {
  n += 1;
  return {
    detectionUid: `d${String(n)}`,
    source,
    acqTsIso: canonicalAcqTsIsoFromInstant(at),
    latCanonical: canonicalDegrees(42.75),
    lonCanonical: canonicalDegrees(lon),
    scanKm: null,
    trackKm: null,
  };
}

const label = (d: FitDetection) =>
  labelDetections([d], [P1, P2], FIT_PARAMS.values, CLUSTERING_PARAMS.values)[0];

describe('labelDetections — DS-3 join (11 §4.1)', () => {
  it('labels a detection inside exactly one perimeter', () => {
    expect(label(det(23.05))).toEqual({ kind: 'labeled', fireId: '2021/p1' });
    expect(label(det(23.15))).toEqual({ kind: 'labeled', fireId: '2021/p2' });
  });

  it('marks a detection that matches two perimeters ambiguous, never a guess', () => {
    expect(label(det(23.095))).toEqual({ kind: 'ambiguous', fireIds: ['2021/p1', '2021/p2'] });
  });

  it('keeps the time window [FIREDATE − 1 d, FINALDATE + 3 d] inclusive', () => {
    expect(label(det(23.05, '2021-07-08T23:00:00Z'))?.kind).toBe('unlabeled');
    expect(label(det(23.05, '2021-07-09T00:00:00Z'))?.kind).toBe('labeled');
    expect(label(det(23.05, '2021-07-15T00:00:00Z'))?.kind).toBe('labeled');
    expect(label(det(23.05, '2021-07-15T00:01:00Z'))?.kind).toBe('unlabeled');
  });

  it('buffers by the source ε, with a 1 km floor', () => {
    // 0.01° of longitude at 42.75° N ≈ 0.82 km; VIIRS ε = 1.25 km.
    expect(label(det(22.99))?.kind).toBe('labeled');
    expect(label(det(22.98))?.kind).toBe('unlabeled');
    // MODIS without scan/track falls back to the 3 km footprint.
    expect(label(det(22.97, undefined, 'firms:modis'))?.kind).toBe('labeled');
    expect(label(det(22.96, undefined, 'firms:modis'))?.kind).toBe('unlabeled');
  });

  it('leaves everything unlabelled when there are no perimeters', () => {
    const labels = labelDetections(
      [det(23.05), det(23.15)],
      [],
      FIT_PARAMS.values,
      CLUSTERING_PARAMS.values,
    );
    expect(summarizeLabels(labels)).toEqual({ labeled: 0, ambiguous: 0, unlabeled: 2 });
  });

  it('summarises in input order', () => {
    const labels = labelDetections(
      [det(23.05), det(23.095), det(25)],
      [P1, P2],
      FIT_PARAMS.values,
      CLUSTERING_PARAMS.values,
    );
    expect(labels.map((l) => l.kind)).toEqual(['labeled', 'ambiguous', 'unlabeled']);
    expect(summarizeLabels(labels)).toEqual({ labeled: 1, ambiguous: 1, unlabeled: 1 });
  });
});
