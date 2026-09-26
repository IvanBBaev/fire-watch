import { describe, expect, it } from 'vitest';

import { isActiveMember, projectChanges, seedKnown } from './change-projector.js';
import { T0, activeRow, changeRow } from './test-rows.js';

const KNOWN = seedKnown({
  maxSeq: 1040,
  events: [activeRow({ publicId: 'a', seq: 1040, status: 'active' })],
});

describe('projectChanges', () => {
  it('returns the very same known map and no frames for no rows', () => {
    const out = projectChanges(KNOWN, [], T0);
    expect(out.frames).toEqual([]);
    expect(out.known).toBe(KNOWN);
  });

  it('creates an event the stream has not seen', () => {
    const out = projectChanges(KNOWN, [changeRow({ publicId: 'b', seq: 1041 })], T0);
    expect(out.frames).toHaveLength(1);
    expect(out.frames[0]).toMatchObject({
      id: 1041,
      event: 'event.created',
      data: { generated_at: '2026-07-14T10:15:00Z', feature: { id: 'b' } },
    });
    expect(out.frames[0]?.data.previous_status).toBeUndefined();
    expect(out.known.get('b')).toBe('active');
  });

  it('updates a known event whose status did not change', () => {
    const out = projectChanges(KNOWN, [changeRow({ publicId: 'a', seq: 1041 })], T0);
    expect(out.frames[0]).toMatchObject({ id: 1041, event: 'event.updated' });
    expect(out.frames[0]?.data.previous_status).toBeUndefined();
  });

  it('reports a status change with the status the stream last told the client', () => {
    const out = projectChanges(
      KNOWN,
      [changeRow({ publicId: 'a', seq: 1041, status: 'officially_contained' })],
      T0,
    );
    expect(out.frames[0]).toMatchObject({
      id: 1041,
      event: 'event.status_changed',
      data: {
        previous_status: 'active',
        feature: { properties: { status: 'officially_contained' } },
      },
    });
    expect(out.known.get('a')).toBe('officially_contained');
  });

  it('emits a merge tombstone with the survivor and forgets the loser', () => {
    const out = projectChanges(
      KNOWN,
      [changeRow({ publicId: 'a', seq: 1041, mergedInto: 'fw-2026-surv' })],
      T0,
    );
    expect(out.frames[0]).toMatchObject({
      id: 1041,
      event: 'event.merged',
      data: { feature: { properties: { merged_into: 'fw-2026-surv' } } },
    });
    expect(out.known.has('a')).toBe(false);
  });

  it('emits nothing for an event that left the map, and forgets it (D3 rule 4)', () => {
    for (const leaving of [
      changeRow({ publicId: 'a', seq: 1041, displayTier: 'feed' }),
      changeRow({ publicId: 'a', seq: 1041, displayTier: 'archive' }),
      changeRow({ publicId: 'a', seq: 1041, invalidated: true }),
    ]) {
      const out = projectChanges(KNOWN, [leaving], T0);
      expect(out.frames).toEqual([]);
      expect(out.known.has('a')).toBe(false);
    }
  });

  it('ignores a change to an event that was never on the map', () => {
    const out = projectChanges(
      KNOWN,
      [changeRow({ publicId: 'z', seq: 1041, displayTier: 'feed' })],
      T0,
    );
    expect(out.frames).toEqual([]);
    expect(out.known.has('z')).toBe(false);
  });

  it('folds a batch left to right, so a create followed by a change is create + status_changed', () => {
    const out = projectChanges(
      KNOWN,
      [
        changeRow({ publicId: 'b', seq: 1041 }),
        changeRow({ publicId: 'b', seq: 1042, status: 'officially_contained' }),
        changeRow({ publicId: 'b', seq: 1043, displayTier: 'archive' }),
        changeRow({ publicId: 'b', seq: 1044 }),
      ],
      T0,
    );
    expect(out.frames.map((frame) => [frame.id, frame.event])).toEqual([
      [1041, 'event.created'],
      [1042, 'event.status_changed'],
      [1044, 'event.created'],
    ]);
  });

  it('does not mutate the map it was given', () => {
    projectChanges(KNOWN, [changeRow({ publicId: 'b', seq: 1041 })], T0);
    expect([...KNOWN.keys()]).toEqual(['a']);
  });
});

describe('isActiveMember', () => {
  it('is the map tier, not a tombstone, not voided — and nothing else', () => {
    // The agreement with `SELECT_ACTIVE_SET`'s WHERE clause is pinned in the adapter's test
    // (core cannot import the adapter to compare the two here).
    expect(isActiveMember(changeRow())).toBe(true);
    expect(isActiveMember(changeRow({ displayTier: 'feed' }))).toBe(false);
    expect(isActiveMember(changeRow({ displayTier: 'archive' }))).toBe(false);
    expect(isActiveMember(changeRow({ mergedInto: 'x' }))).toBe(false);
    expect(isActiveMember(changeRow({ invalidated: true }))).toBe(false);
  });
});

describe('seedKnown', () => {
  it('records every seeded event with its status', () => {
    expect([...KNOWN]).toEqual([['a', 'active']]);
  });
});
