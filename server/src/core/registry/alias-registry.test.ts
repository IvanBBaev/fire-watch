import { describe, expect, it } from 'vitest';

import {
  AliasCycleError,
  NO_ALIASES,
  applyRewrites,
  compressAll,
  diffRewrites,
  isTombstone,
  linkTombstone,
  resolveAlias,
  type AliasLinks,
} from './alias-registry.js';

function table(entries: Record<string, string>): AliasLinks {
  return new Map(Object.entries(entries));
}

describe('resolveAlias — I1: a published id resolves forever', () => {
  it('answers for an id it has never heard of', () => {
    // Totality is the point: the API calls this on every lookup and must not have to ask
    // "is this a tombstone" first. A live event is its own canonical.
    expect(resolveAlias(NO_ALIASES, 'fw-2026-q7f3d')).toEqual({
      canonical: 'fw-2026-q7f3d',
      hops: 0,
      rewrites: [],
    });
  });

  it('resolves a flat tombstone in one hop, with nothing to compress', () => {
    const links = table({ 'fw-2026-z7c3f': 'fw-2026-q7f3d' });
    expect(resolveAlias(links, 'fw-2026-z7c3f')).toEqual({
      canonical: 'fw-2026-q7f3d',
      hops: 1,
      rewrites: [],
    });
  });

  it('walks a chain and reports the compression it earned', () => {
    const links = table({ a: 'b', b: 'c', c: 'd' });
    const resolution = resolveAlias(links, 'a');

    expect(resolution.canonical).toBe('d');
    expect(resolution.hops).toBe(3);
    // `c` already points at `d`; rewriting it would be a no-op write.
    expect(resolution.rewrites).toEqual([
      { publicId: 'a', from: 'b', to: 'd' },
      { publicId: 'b', from: 'c', to: 'd' },
    ]);
  });

  it('is idempotent once the rewrites are applied — I2 convergence', () => {
    const links = table({ a: 'b', b: 'c', c: 'd' });
    const flat = applyRewrites(links, resolveAlias(links, 'a').rewrites);

    expect(resolveAlias(flat, 'a')).toEqual({ canonical: 'd', hops: 1, rewrites: [] });
    expect(resolveAlias(flat, 'b')).toEqual({ canonical: 'd', hops: 1, rewrites: [] });
  });

  it('throws on a cycle instead of walking it forever', () => {
    // A cycle here is a bug in whatever wrote the table. Failing loudly at the read turns
    // it into a bug report; looping turns it into an outage, and the read path is the API.
    expect(() => resolveAlias(table({ a: 'b', b: 'c', c: 'a' }), 'a')).toThrow(AliasCycleError);
    expect(() => resolveAlias(table({ a: 'b', b: 'c', c: 'a' }), 'a')).toThrow(/a -> b -> c -> a/);
  });

  it('throws on a self-loop', () => {
    expect(() => resolveAlias(table({ a: 'a' }), 'a')).toThrow(AliasCycleError);
  });
});

describe('linkTombstone', () => {
  it('records the merge and leaves the input table untouched', () => {
    const before = NO_ALIASES;
    const { links } = linkTombstone(before, 'loser', 'survivor');

    expect(links.get('loser')).toBe('survivor');
    expect(isTombstone(links, 'loser')).toBe(true);
    expect(isTombstone(links, 'survivor')).toBe(false);
    expect(before.size).toBe(0);
  });

  it('writes the link already flat when the survivor is itself a tombstone', () => {
    // A absorbed by B on Tuesday, B absorbed by C on Wednesday: the row written on
    // Wednesday points at C, not at B. Chains only ever arrive from elsewhere.
    const links = table({ b: 'c' });
    const linked = linkTombstone(links, 'a', 'b');

    expect(linked.links.get('a')).toBe('c');
    expect(resolveAlias(linked.links, 'a').hops).toBe(1);
  });

  it('compresses the survivor path it had to walk', () => {
    const links = table({ b: 'c', c: 'd' });
    const linked = linkTombstone(links, 'a', 'b');

    expect(linked.rewrites).toEqual([{ publicId: 'b', from: 'c', to: 'd' }]);
    expect(linked.links.get('a')).toBe('d');
    expect(linked.links.get('b')).toBe('d');
  });

  it('refuses a self-merge, as the fire_events_merged_into_not_self constraint does', () => {
    expect(() => linkTombstone(NO_ALIASES, 'a', 'a')).toThrow(RangeError);
  });

  it('refuses a link that would close a cycle', () => {
    expect(() => linkTombstone(table({ b: 'a' }), 'a', 'b')).toThrow(AliasCycleError);
  });

  it('refuses to re-absorb a tombstone into a different survivor', () => {
    // Two merges claiming the same loser means the working set and the registry disagree
    // about what is live. Picking a winner here would hide that behind a plausible answer.
    expect(() => linkTombstone(table({ a: 'b' }), 'a', 'c')).toThrow(/already merged into b/);
  });

  it('accepts a replay of a merge that already happened — I4 replay silence', () => {
    const links = table({ a: 'b' });
    const linked = linkTombstone(links, 'a', 'b');

    expect(linked.links.get('a')).toBe('b');
    expect(linked.rewrites).toEqual([]);
  });

  it('accepts a replay that names the pre-compression survivor', () => {
    // The merge happened when `b` was live; `b` has since been absorbed by `c`. Replaying
    // it must be silent, not a conflict — the outcome it asserts is still the outcome.
    const links = table({ a: 'c', b: 'c' });
    const linked = linkTombstone(links, 'a', 'b');

    expect(linked.links.get('a')).toBe('c');
  });
});

describe('compressAll and diffRewrites', () => {
  it('flattens every tombstone in one pass', () => {
    const flat = compressAll(table({ a: 'b', b: 'c', c: 'd', x: 'd' }));

    expect([...flat.entries()].sort()).toEqual([
      ['a', 'd'],
      ['b', 'd'],
      ['c', 'd'],
      ['x', 'd'],
    ]);
  });

  it('reports only the pointers that actually moved, ascending by public id', () => {
    const before = table({ a: 'b', b: 'c', c: 'd', x: 'd' });
    expect(diffRewrites(before, compressAll(before))).toEqual([
      { publicId: 'a', from: 'b', to: 'd' },
      { publicId: 'b', from: 'c', to: 'd' },
    ]);
  });

  it('reports nothing for a table that is already flat', () => {
    const flat = table({ a: 'c', b: 'c' });
    expect(diffRewrites(flat, compressAll(flat))).toEqual([]);
  });
});
