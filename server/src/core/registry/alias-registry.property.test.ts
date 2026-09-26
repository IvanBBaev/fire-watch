/**
 * I2 — alias convergence, as a property rather than a list of cases.
 *
 * The invariant is not "this chain resolves"; it is that *no* sequence of merges can
 * produce a table that fails to resolve, that resolves to something dead, or that resolves
 * differently depending on how many times you ask. Merges arrive in whatever order the
 * satellites and the batch scheduler produce them, and a hand-written case list can only
 * ever assert the orders someone thought of.
 *
 * The reference model is a union-find over the same pool, built with the operations
 * spelled out plainly. Agreement between it and the alias table is what "converges" means
 * here: two implementations of the same idea, one written for clarity and one written for
 * the invariants, forced to give the same answer on every generated history.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  NO_ALIASES,
  applyRewrites,
  compressAll,
  isTombstone,
  linkTombstone,
  resolveAlias,
  type AliasLinks,
} from './alias-registry.js';

const POOL = 12;
const ids = Array.from(
  { length: POOL },
  (_, index) => `fw-2026-e${String(index).padStart(2, '0')}`,
);

/** Naive union-find: representatives only, no compression, no rank. Slow and obvious. */
class Reference {
  private readonly parent = new Map<string, string>();

  representative(id: string): string {
    let current = id;
    for (;;) {
      const next = this.parent.get(current);
      if (next === undefined) return current;
      current = next;
    }
  }

  union(loser: string, survivor: string): void {
    this.parent.set(loser, survivor);
  }
}

interface History {
  readonly links: AliasLinks;
  readonly reference: Reference;
  /** Every id that has ever been a loser. These are the ones I1 promises resolve. */
  readonly absorbed: readonly string[];
  /** Hops of each row at the moment it was written — the flat-write rule, step by step. */
  readonly hopsAtWrite: readonly number[];
}

/**
 * Replays a generated merge sequence. The survivor is passed *unresolved* on purpose —
 * that is the realistic call, since a merge is decided from the working set while the
 * registry may already have moved on, and it is the path where the flat-write rule earns
 * its keep.
 */
function replay(pairs: readonly (readonly [number, number])[]): History {
  let links = NO_ALIASES;
  const reference = new Reference();
  const absorbed: string[] = [];
  const hopsAtWrite: number[] = [];

  for (const [left, right] of pairs) {
    const loserSeed = ids[left % POOL] as string;
    const survivorSeed = ids[right % POOL] as string;
    const loser = reference.representative(loserSeed);
    if (loser === reference.representative(survivorSeed)) continue;

    links = linkTombstone(links, loser, survivorSeed).links;
    reference.union(loser, reference.representative(survivorSeed));
    absorbed.push(loser);
    hopsAtWrite.push(resolveAlias(links, loser).hops);
  }
  return { links, reference, absorbed, hopsAtWrite };
}

const histories = fc
  .array(fc.tuple(fc.nat(POOL - 1), fc.nat(POOL - 1)), { maxLength: 40 })
  .map(replay);

describe('I2 — alias convergence', () => {
  it('resolves every id ever issued, live or absorbed', () => {
    fc.assert(
      fc.property(histories, ({ links, reference }) => {
        for (const id of ids) {
          expect(resolveAlias(links, id).canonical).toBe(reference.representative(id));
        }
      }),
    );
  });

  it('never resolves to a tombstone — the canonical is always live', () => {
    // The point of resolution. An answer that is itself an alias would push the walk onto
    // the caller, and the caller is the API handler.
    fc.assert(
      fc.property(histories, ({ links }) => {
        for (const id of ids) {
          expect(isTombstone(links, resolveAlias(links, id).canonical)).toBe(false);
        }
      }),
    );
  });

  it('keeps an absorbed id pointing at whatever is live now — I1 permanence', () => {
    // The id in someone's bookmark was absorbed three merges ago. It still answers, and it
    // answers with the fire they are actually looking at, not the one it was absorbed into.
    fc.assert(
      fc.property(histories, ({ links, reference, absorbed }) => {
        for (const id of absorbed) {
          expect(isTombstone(links, id)).toBe(true);
          expect(resolveAlias(links, id).canonical).toBe(reference.representative(id));
        }
      }),
    );
  });

  it('writes every new row flat, and only a later merge can lengthen it', () => {
    // The survivor is resolved before the row is written, so no row is ever born with a
    // chain in front of it. Rows do not *stay* flat by themselves — absorbing an event that
    // other tombstones point at costs each of them one hop — so the bound this rule really
    // buys is: a chain grows only when its head is absorbed, and one compression pass
    // removes all of it.
    fc.assert(
      fc.property(histories, ({ links, hopsAtWrite }) => {
        expect(hopsAtWrite.every((hops) => hops === 1)).toBe(true);
        const flat = compressAll(links);
        for (const id of flat.keys()) {
          expect(resolveAlias(flat, id).hops).toBe(1);
        }
      }),
    );
  });

  it('compresses to a fixed point — a second pass has nothing left to do', () => {
    fc.assert(
      fc.property(histories, ({ links }) => {
        const once = compressAll(links);
        const twice = compressAll(once);
        expect([...twice.entries()].sort()).toEqual([...once.entries()].sort());
        for (const id of ids) {
          expect(resolveAlias(once, id).rewrites).toEqual([]);
        }
      }),
    );
  });

  it('gives the same canonical before and after compression', () => {
    fc.assert(
      fc.property(histories, ({ links }) => {
        const flat = compressAll(links);
        for (const id of ids) {
          expect(resolveAlias(flat, id).canonical).toBe(resolveAlias(links, id).canonical);
        }
      }),
    );
  });

  it('has exactly one live event per merged component', () => {
    fc.assert(
      fc.property(histories, ({ links }) => {
        const live = ids.filter((id) => !isTombstone(links, id));
        const canonicals = new Set(ids.map((id) => resolveAlias(links, id).canonical));
        expect([...canonicals].sort()).toEqual(live.sort());
      }),
    );
  });
});

describe('I2 — resolution survives a table that arrived chained', () => {
  it('flattens an arbitrary chain and agrees with the walk', () => {
    // A table written before path compression existed, or by a replay that applied merges
    // out of order. Resolution has to be total there too, not only on tables it built.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: POOL - 1 }), (length) => {
        // Strictly increasing by construction — e0 -> e1 -> ... -> e<length> — so the table
        // is a chain of the generated length and cannot close into a cycle.
        const chained = new Map<string, string>();
        for (let index = 0; index < length; index += 1) {
          chained.set(ids[index] as string, ids[index + 1] as string);
        }
        const last = ids[length] as string;

        // Every position on the chain, not only the head: resolution has to be total, and
        // the walk from the middle is the one a bookmarked id actually takes.
        for (let index = 0; index < length; index += 1) {
          const from = ids[index] as string;
          const resolution = resolveAlias(chained, from);
          expect(resolution.canonical).toBe(last);
          expect(resolution.hops).toBe(length - index);

          const flat = applyRewrites(chained, resolution.rewrites);
          expect(resolveAlias(flat, from)).toEqual({ canonical: last, hops: 1, rewrites: [] });
        }
      }),
    );
  });
});
