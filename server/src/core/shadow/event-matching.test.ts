import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { matchEvents, type MatchableEvent } from './event-matching.js';

const T0 = Date.UTC(2026, 7, 20, 6, 0, 0);

function event(key: string, uids: readonly string[], startedAtMs = T0): MatchableEvent {
  return { key, startedAtMs, detectionUids: uids };
}

describe('the Jaccard threshold', () => {
  it('pairs at exactly 0.5 — the threshold is inclusive', () => {
    // {a,b} vs {a,c}: 1/3, below. {a,b} vs {a,b,c,d}: 2/4, exactly on it.
    const onIt = matchEvents([event('L', ['a', 'b'])], [event('S', ['a', 'b', 'c', 'd'])], 0.5);
    expect(onIt.matches).toEqual([{ liveKey: 'L', shadowKey: 'S', intersection: 2, union: 4 }]);

    const below = matchEvents([event('L', ['a', 'b'])], [event('S', ['a', 'c'])], 0.5);
    expect(below.matches).toEqual([]);
    expect(below.unmatchedLive).toEqual(['L']);
    expect(below.unmatchedShadow).toEqual(['S']);
  });

  it('never pairs events that share nothing, whatever the threshold', () => {
    expect(matchEvents([event('L', ['a'])], [event('S', ['b'])], 1e-9).matches).toEqual([]);
  });

  it('refuses a threshold outside (0, 1]', () => {
    for (const bad of [0, -0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => matchEvents([], [], bad)).toThrow(RangeError);
    }
    expect(() => matchEvents([], [], 1)).not.toThrow();
  });
});

describe('greedy, one-to-one claiming', () => {
  it('lets the strongest pairing claim first, so a weak overlap cannot steal an event', () => {
    // L1 pairs with S1 at 2/4 and with S2 at 2/2; L2 pairs only with S1, at 2/4. Taking
    // L1's first qualifying pair would give L1→S1 and strand L2; greedy gives L1→S2, L2→S1.
    const live = [event('L1', ['a', 'b']), event('L2', ['d', 'e'])];
    const shadow = [event('S1', ['a', 'b', 'd', 'e']), event('S2', ['a', 'b'])];
    const result = matchEvents(live, shadow, 0.5);
    expect(result.matches.map((m) => [m.liveKey, m.shadowKey])).toEqual([
      ['L1', 'S2'],
      ['L2', 'S1'],
    ]);
  });

  it('claims each side at most once and leaves the rest unmatched', () => {
    // One live fire, two identical shadow halves of it: only one can be its pair.
    const result = matchEvents(
      [event('L', ['a', 'b'])],
      [event('S1', ['a', 'b']), event('S2', ['a', 'b'])],
      0.5,
    );
    expect(result.matches).toHaveLength(1);
    expect(result.unmatchedShadow).toHaveLength(1);
  });

  it('breaks an exact tie by the older live event, then its id', () => {
    const shadow = [event('S', ['a', 'b'])];
    const older = matchEvents(
      [event('L-young', ['a', 'b'], T0 + 1), event('L-old', ['a', 'b'], T0)],
      shadow,
      0.5,
    );
    expect(older.matches[0]?.liveKey).toBe('L-old');

    const sameAge = matchEvents([event('L-b', ['a', 'b']), event('L-a', ['a', 'b'])], shadow, 0.5);
    expect(sameAge.matches[0]?.liveKey).toBe('L-a');
  });

  it('breaks a tie on the shadow side the same way', () => {
    const live = [event('L', ['a', 'b'])];
    const result = matchEvents(
      live,
      [event('S-young', ['a', 'b'], T0 + 1), event('S-old', ['a', 'b'], T0)],
      0.5,
    );
    expect(result.matches[0]?.shadowKey).toBe('S-old');
  });

  it('treats equal fractions of different sizes as a tie and hands it to the D7 order', () => {
    // 2/4 and 4/8 are the same Jaccard; the older live event wins although it is listed second.
    const shadow = [event('S', ['a', 'b', 'c', 'd'])];
    const live = [
      event('L-young', ['a', 'b'], T0 + 1),
      event('L-old', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], T0),
    ];
    expect(matchEvents(live, shadow, 0.5).matches).toEqual([
      { liveKey: 'L-old', shadowKey: 'S', intersection: 4, union: 8 },
    ]);
  });
});

describe('input validation', () => {
  it('refuses duplicate keys on either side', () => {
    expect(() => matchEvents([event('L', ['a']), event('L', ['b'])], [], 0.5)).toThrow(/live/);
    expect(() => matchEvents([], [event('S', ['a']), event('S', ['b'])], 0.5)).toThrow(/shadow/);
  });

  it('refuses a detection listed twice in one event', () => {
    expect(() => matchEvents([event('L', ['a', 'a'])], [], 0.5)).toThrow(/twice/);
    expect(() => matchEvents([], [event('S', ['a', 'a'])], 0.5)).toThrow(/twice/);
  });
});

describe('determinism', () => {
  const uid = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
  const side = (prefix: string) =>
    fc
      .uniqueArray(
        fc.record({
          key: fc.constantFrom('1', '2', '3', '4', '5').map((n) => `${prefix}${n}`),
          startedAtMs: fc.nat(3).map((n) => T0 + n),
          detectionUids: fc.uniqueArray(uid, { minLength: 1, maxLength: 5 }),
        }),
        { selector: (e) => e.key, maxLength: 5 },
      )
      .map((events) => events as MatchableEvent[]);

  it('returns the same matching for any input order', () => {
    fc.assert(
      fc.property(
        side('L'),
        side('S'),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        (live, shadow, minJaccard) => {
          const forward = matchEvents(live, shadow, minJaccard);
          const reversed = matchEvents(
            live
              .slice()
              .reverse()
              .map((e) => ({ ...e, detectionUids: [...e.detectionUids].reverse() })),
            shadow.slice().reverse(),
            minJaccard,
          );
          expect(reversed).toEqual(forward);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never claims either side twice and accounts for every event', () => {
    fc.assert(
      fc.property(side('L'), side('S'), (live, shadow) => {
        const result = matchEvents(live, shadow, 0.5);
        const liveKeys = result.matches.map((m) => m.liveKey);
        const shadowKeys = result.matches.map((m) => m.shadowKey);
        expect(new Set(liveKeys).size).toBe(liveKeys.length);
        expect(new Set(shadowKeys).size).toBe(shadowKeys.length);
        expect(liveKeys.length + result.unmatchedLive.length).toBe(live.length);
        expect(shadowKeys.length + result.unmatchedShadow.length).toBe(shadow.length);
        for (const m of result.matches) expect(2 * m.intersection).toBeGreaterThanOrEqual(m.union);
      }),
      { numRuns: 200 },
    );
  });
});
