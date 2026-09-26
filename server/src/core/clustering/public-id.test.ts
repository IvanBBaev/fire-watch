import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import { PUBLIC_ID_ALPHABET, PUBLIC_ID_RE, mintPublicId } from './public-id.js';

const free = (): boolean => false;
const mintedAt = epochMsFromIso('2026-08-15T09:00:00Z');

describe('mintPublicId', () => {
  it('matches the shape the schema CHECK enforces', () => {
    const id = mintPublicId({ seed: 'detection-uid-1', mintedAt, isTaken: free });
    expect(id).toMatch(PUBLIC_ID_RE);
    expect(id.startsWith('fw-2026-')).toBe(true);
  });

  it('is a pure function of the seed, the year and the probe (I5)', () => {
    // The determinism that makes a golden fixture possible: a replay of the same batch
    // mints the same id, so `expected.json` can assert one.
    const first = mintPublicId({ seed: 'detection-uid-1', mintedAt, isTaken: free });
    const second = mintPublicId({ seed: 'detection-uid-1', mintedAt, isTaken: free });
    expect(second).toBe(first);
  });

  it('gives different seeds different ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      ids.add(mintPublicId({ seed: `uid-${String(i)}`, mintedAt, isTaken: free }));
    }
    // A 25-bit suffix over 2 000 seeds: the birthday bound puts the expected number of
    // collisions near 0.06, so a handful would be a broken hash rather than bad luck.
    expect(ids.size).toBeGreaterThanOrEqual(1998);
  });

  it('probes past a collision instead of minting a duplicate', () => {
    const first = mintPublicId({ seed: 'collide', mintedAt, isTaken: free });
    const second = mintPublicId({
      seed: 'collide',
      mintedAt,
      isTaken: (candidate) => candidate === first,
    });
    expect(second).not.toBe(first);
    expect(second).toMatch(PUBLIC_ID_RE);
  });

  it('gives up loudly rather than spinning when every probe is taken', () => {
    expect(() => mintPublicId({ seed: 'x', mintedAt, isTaken: () => true })).toThrow(
      /could not mint a free public id/,
    );
  });

  it('takes the year from the mint instant, not from the fire (A2.1)', () => {
    // An event that starts on 31 December and is still burning in January keeps the id it
    // was minted with. The year is cosmetic, never parsed, and never corrected.
    const newYear = mintPublicId({
      seed: 'same-seed',
      mintedAt: epochMsFromIso('2027-01-01T00:00:00Z'),
      isTaken: free,
    });
    const oldYear = mintPublicId({ seed: 'same-seed', mintedAt, isTaken: free });
    expect(newYear.slice(0, 8)).toBe('fw-2027-');
    // Same seed, same suffix: only the cosmetic segment moved.
    expect(newYear.slice(8)).toBe(oldYear.slice(8));
  });

  it('needs a seed', () => {
    expect(() => mintPublicId({ seed: '', mintedAt, isTaken: free })).toThrow(RangeError);
  });
});

describe('the alphabet', () => {
  it('is Crockford base32 in lowercase — no i, l, o or u', () => {
    // An id is read off a screen and typed into a search box. `1`/`l` and `0`/`O` are the
    // usual confusions; `u` is dropped so an accident cannot spell an obscenity.
    expect(PUBLIC_ID_ALPHABET).toHaveLength(32);
    expect(new Set(PUBLIC_ID_ALPHABET).size).toBe(32);
    for (const letter of ['i', 'l', 'o', 'u']) {
      expect(PUBLIC_ID_ALPHABET).not.toContain(letter);
    }
  });

  it('only ever appears in a minted id', () => {
    for (let i = 0; i < 500; i += 1) {
      const id = mintPublicId({ seed: `uid-${String(i)}`, mintedAt, isTaken: free });
      for (const character of id.slice(8)) {
        expect(PUBLIC_ID_ALPHABET).toContain(character);
      }
    }
  });
});
