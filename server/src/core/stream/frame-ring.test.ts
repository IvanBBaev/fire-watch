import { describe, expect, it } from 'vitest';

import { createFrameRing } from './frame-ring.js';
import { frame } from './test-rows.js';

describe('createFrameRing', () => {
  it('starts empty at the floor: latest is the floor, replay from it is empty', () => {
    const ring = createFrameRing({ capacity: 3, floor: 100 });
    expect(ring.size).toBe(0);
    expect(ring.latest).toBe(100);
    expect(ring.replayAfter(100)).toEqual({ kind: 'replay', frames: [] });
  });

  it('replays every frame above the cursor, in order', () => {
    const ring = createFrameRing({ capacity: 10, floor: 100 });
    for (const id of [101, 105, 106]) ring.push(frame(id));
    const outcome = ring.replayAfter(101);
    expect(outcome.kind).toBe('replay');
    if (outcome.kind === 'replay') expect(outcome.frames.map((f) => f.id)).toEqual([105, 106]);
  });

  it('treats a cursor inside an id hole as "missed nothing since that hole"', () => {
    // Ids skip 102–104 (rows that left the map draw a seq but no frame). A client that
    // somehow holds 103 has seen everything up to 103 and gets 105 onward.
    const ring = createFrameRing({ capacity: 10, floor: 100 });
    for (const id of [101, 105]) ring.push(frame(id));
    expect(ring.replayAfter(103)).toEqual({ kind: 'replay', frames: [frame(105)] });
  });

  it('resets as too_old below the floor, including one below the seed floor', () => {
    const ring = createFrameRing({ capacity: 10, floor: 100 });
    expect(ring.replayAfter(99)).toEqual({ kind: 'reset', reason: 'too_old' });
    ring.push(frame(101));
    expect(ring.replayAfter(99)).toEqual({ kind: 'reset', reason: 'too_old' });
  });

  it('resets as unknown above the newest id, or for a cursor that is not an id at all', () => {
    const ring = createFrameRing({ capacity: 10, floor: 100 });
    ring.push(frame(101));
    expect(ring.replayAfter(102)).toEqual({ kind: 'reset', reason: 'unknown' });
    expect(ring.replayAfter(-1)).toEqual({ kind: 'reset', reason: 'unknown' });
    expect(ring.replayAfter(1.5)).toEqual({ kind: 'reset', reason: 'unknown' });
    expect(ring.replayAfter(Number.NaN)).toEqual({ kind: 'reset', reason: 'unknown' });
  });

  it('raises the floor to the evicted id once the capacity is exceeded', () => {
    const ring = createFrameRing({ capacity: 2, floor: 0 });
    ring.push(frame(1));
    ring.push(frame(2));
    expect(ring.floor).toBe(0);
    ring.push(frame(3));
    expect(ring.size).toBe(2);
    expect(ring.floor).toBe(1);
    // Exactly the evicted id still replays (the client saw it); one below it does not.
    expect(ring.replayAfter(1)).toEqual({ kind: 'replay', frames: [frame(2), frame(3)] });
    expect(ring.replayAfter(0)).toEqual({ kind: 'reset', reason: 'too_old' });
  });

  it('survives many evictions without the head growing unbounded', () => {
    const ring = createFrameRing({ capacity: 5, floor: 0 });
    for (let id = 1; id <= 1_000; id += 1) ring.push(frame(id));
    expect(ring.size).toBe(5);
    expect(ring.floor).toBe(995);
    expect(ring.latest).toBe(1_000);
    expect(ring.replayAfter(997)).toEqual({
      kind: 'replay',
      frames: [frame(998), frame(999), frame(1_000)],
    });
  });

  it('refuses an id that does not increase — silently accepting it would corrupt replays', () => {
    const ring = createFrameRing({ capacity: 10, floor: 100 });
    expect(() => ring.push(frame(100))).toThrow(RangeError);
    ring.push(frame(101));
    expect(() => ring.push(frame(101))).toThrow(RangeError);
    expect(() => ring.push(frame(50))).toThrow(RangeError);
    expect(ring.size).toBe(1);
  });

  it('refuses a nonsensical capacity or floor', () => {
    expect(() => createFrameRing({ capacity: 0, floor: 0 })).toThrow(RangeError);
    expect(() => createFrameRing({ capacity: 1.5, floor: 0 })).toThrow(RangeError);
    expect(() => createFrameRing({ capacity: 1, floor: -1 })).toThrow(RangeError);
  });
});
