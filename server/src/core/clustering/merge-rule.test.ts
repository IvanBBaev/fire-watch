import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import { chooseSurvivor, compareSurvivor } from './merge-rule.js';
import type { Cluster, ClusterMember } from './types.js';

function member(index: number): ClusterMember {
  return {
    detectionUid: `uid-${String(index)}`,
    source: 'firms:viirs:snpp',
    acqTsIso: '2026-08-15T09:00:00Z',
    acqTs: epochMsFromIso('2026-08-15T09:00:00Z'),
    latCanonical: '41.90000',
    lonCanonical: '23.50000',
    coordinate: { lat: 41.9, lon: 23.5 },
    epsKm: 1.25,
    footprintDefaulted: false,
  };
}

function cluster(spec: { id: number; startedAtIso: string; size: number }): Cluster {
  const startedAt = epochMsFromIso(spec.startedAtIso);
  return {
    id: spec.id,
    publicId: `fw-2026-${String(spec.id).padStart(5, '0')}`,
    seedDetectionUid: `seed-${String(spec.id)}`,
    mintedAt: startedAt,
    startedAt,
    lastDetectionAt: startedAt,
    members: Array.from({ length: spec.size }, (_, index) => member(index)),
    configVersion: 'clustering_params_v1',
    sourceRegistryVersion: 'source_registry_v1',
  };
}

describe('compareSurvivor — ADR-002 D3 rule 1: min by (started_at, −detection_count, id)', () => {
  it('lets the oldest event win', () => {
    // The survivor keeps its public_id, and the id people have already been given belongs
    // to the fire they have been watching longest. A younger, larger cluster absorbing the
    // older one would retire an id that is already in a bookmark and a push notification.
    const older = cluster({ id: 7, startedAtIso: '2026-08-14T00:00:00Z', size: 2 });
    const younger = cluster({ id: 2, startedAtIso: '2026-08-15T00:00:00Z', size: 40 });
    expect(chooseSurvivor([younger, older])).toBe(older);
    expect(chooseSurvivor([older, younger])).toBe(older);
  });

  it('breaks a start-time tie by the larger cluster', () => {
    const small = cluster({ id: 1, startedAtIso: '2026-08-15T00:00:00Z', size: 3 });
    const large = cluster({ id: 9, startedAtIso: '2026-08-15T00:00:00Z', size: 11 });
    expect(chooseSurvivor([small, large])).toBe(large);
    // Sign check: `−detection_count` ascending means the bigger count sorts first, which is
    // the one place in the rule where an inverted comparison still compiles and still
    // returns a plausible answer.
    expect(compareSurvivor(large, small)).toBeLessThan(0);
  });

  it('breaks a full tie by the lowest internal id', () => {
    const low = cluster({ id: 4, startedAtIso: '2026-08-15T00:00:00Z', size: 5 });
    const high = cluster({ id: 12, startedAtIso: '2026-08-15T00:00:00Z', size: 5 });
    expect(chooseSurvivor([high, low])).toBe(low);
  });

  it('is a total order, so a merge can never be ambiguous', () => {
    // Internal ids are unique, so the last key alone decides every otherwise-equal pair.
    // This is what makes the survivor independent of the order candidates were found in —
    // and the candidate scan walks the working set, whose order a future refactor could
    // change without anyone thinking about merges.
    const clusters = [
      cluster({ id: 3, startedAtIso: '2026-08-15T00:00:00Z', size: 5 }),
      cluster({ id: 1, startedAtIso: '2026-08-14T00:00:00Z', size: 1 }),
      cluster({ id: 8, startedAtIso: '2026-08-15T00:00:00Z', size: 5 }),
      cluster({ id: 5, startedAtIso: '2026-08-14T00:00:00Z', size: 9 }),
    ];
    for (const a of clusters) {
      for (const b of clusters) {
        if (a === b) {
          expect(compareSurvivor(a, b)).toBe(0);
        } else {
          expect(compareSurvivor(a, b)).not.toBe(0);
          expect(Math.sign(compareSurvivor(a, b))).toBe(-Math.sign(compareSurvivor(b, a)));
        }
      }
    }
  });

  it('picks the same survivor whatever order the candidates arrive in', () => {
    const clusters = [
      cluster({ id: 3, startedAtIso: '2026-08-15T00:00:00Z', size: 5 }),
      cluster({ id: 1, startedAtIso: '2026-08-14T06:00:00Z', size: 1 }),
      cluster({ id: 8, startedAtIso: '2026-08-14T06:00:00Z', size: 5 }),
      cluster({ id: 5, startedAtIso: '2026-08-16T00:00:00Z', size: 9 }),
    ];
    // Cluster 8 is the answer: it ties with 1 on the oldest start and is the larger of the
    // two. Every rotation must agree.
    for (let offset = 0; offset < clusters.length; offset += 1) {
      const rotated = [...clusters.slice(offset), ...clusters.slice(0, offset)];
      expect(chooseSurvivor(rotated).id).toBe(8);
    }
  });

  it('refuses an empty merge', () => {
    expect(() => chooseSurvivor([])).toThrow(RangeError);
  });
});
