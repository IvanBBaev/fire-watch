import { describe, expect, it } from 'vitest';

import {
  CURATED_LIFECYCLE_STATES,
  LIFECYCLE_STATES,
  MACHINE_LIFECYCLE_STATES,
  RELATION_KINDS,
  SCORE_BUCKET_FLOOR,
  assertLifecycleState,
  isCuratedLifecycleState,
  isLifecycleState,
  isRelationKind,
  scoreBucket,
} from './lifecycle.js';

describe('lifecycle states', () => {
  it('matches the closed list in the schema CHECK and GLOSSARY §3', () => {
    expect([...LIFECYCLE_STATES]).toEqual([
      'active',
      'signal_weakening',
      'no_longer_detected',
      'archived',
      'officially_contained',
      'officially_extinguished',
    ]);
  });

  it('never admits a word that claims the fire is out', () => {
    // The whole product position is that satellites cannot see this. A state named
    // `out`, `extinguished` or `safe` arriving by refactor must fail here, loudly.
    for (const banned of ['out', 'extinguished', 'safe', 'resolved', 'contained']) {
      expect(isLifecycleState(banned), `${banned} must not be a state`).toBe(false);
    }
  });

  it('keeps the curated states out of the machine set', () => {
    for (const state of CURATED_LIFECYCLE_STATES) {
      expect(isCuratedLifecycleState(state)).toBe(true);
      expect((MACHINE_LIFECYCLE_STATES as readonly string[]).includes(state)).toBe(false);
    }
    for (const state of MACHINE_LIFECYCLE_STATES) {
      expect(isCuratedLifecycleState(state)).toBe(false);
    }
  });

  it('throws with the permitted list when asserting an unknown state', () => {
    expect(() => {
      assertLifecycleState('smouldering');
    }).toThrow(/officially_extinguished/);
    expect(() => {
      assertLifecycleState('active');
    }).not.toThrow();
  });
});

describe('relation kinds', () => {
  it('offers only hedged relations', () => {
    expect([...RELATION_KINDS]).toEqual(['possible_reignition', 'continuation']);
    expect(isRelationKind('same_fire')).toBe(false);
  });
});

describe('scoreBucket', () => {
  it('closes each bucket at the bottom', () => {
    expect(scoreBucket(SCORE_BUCKET_FLOOR.confirmed)).toBe('confirmed');
    expect(scoreBucket(SCORE_BUCKET_FLOOR.confirmed - 1e-9)).toBe('likely');
    expect(scoreBucket(SCORE_BUCKET_FLOOR.likely)).toBe('likely');
    expect(scoreBucket(SCORE_BUCKET_FLOOR.likely - 1e-9)).toBe('unverified');
  });

  it('covers the whole probability range', () => {
    expect(scoreBucket(0)).toBe('unverified');
    expect(scoreBucket(1)).toBe('confirmed');
  });

  it('rejects anything that is not a probability', () => {
    expect(() => scoreBucket(1.2)).toThrow(RangeError);
    expect(() => scoreBucket(-0.1)).toThrow(RangeError);
    expect(() => scoreBucket(Number.NaN)).toThrow(RangeError);
  });
});
