/**
 * S15's server half — the real `/snapshot.json` route under a cursor-only client
 * (GATES §1.1 S15, ADR-003 A1.5, rule R1).
 *
 * The scenario is proven in `web/src/core/feed/cursor-client.property.test.ts`, which
 * drives the real client pipeline against a *simulated* origin, and the register names
 * that suite as S15's proof. That leaves one seam unproven by it: the simulation is a
 * copy of this route's wire contract, and a copy can drift. So this suite runs the other
 * direction — the real route, over an in-memory registry that obeys R1 (every create,
 * update *and removal* takes the next global seq), under the smallest client that obeys
 * the reconciler's rules — and asserts the same outcome: after every full fetch the
 * client holds exactly the server's active set, so a removal is on the client within one
 * full-snapshot cycle however cursors and fulls interleave with it.
 *
 * The client is deliberately minimal and mirrors `web/src/core/store/reconciler.ts` and
 * `polling-feed.ts` only where the property depends on them: upsert iff `seq` is newer,
 * never delete on a partial response, delete an absent member on a full response iff
 * `max_seq` is above its stored seq, advance the cursor to `max_seq`, and keep **two**
 * ETag slots — a full request carries only a tag learned from a full `200`.
 *
 * The last `describe` pins why that last rule is not optional. The route gives a cursor
 * response and a full response the same tag when the mark is the same (both are
 * `"v1-<max_seq>"`), so a client with one ETag slot that learns the post-removal mark from
 * a cursor then revalidates its full fetch with it, gets a `304`, and keeps the removed
 * event until some unrelated change moves the mark. The web client is immune by
 * construction; a third-party consumer is not, and nothing on the wire tells it so. If
 * the tag ever gains a partial/full component, that pin flips and should be rewritten as
 * the positive case, not deleted.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type { ActiveEventRow, SnapshotReader } from '../../core/ports/snapshot-reader.js';
import { activeRow } from '../../core/stream/test-rows.js';
import { CURSOR_PARAM, SNAPSHOT_PATH, registerSnapshotRoute } from './snapshot-route.js';

const NOW = '2026-07-14T10:15:00Z';

/**
 * A1.5's cadence, in polls: a 10-minute safety full over a 45-second poll is at most 13
 * cursor polls between fulls. The property forces a full every `FULL_EVERY` polls and
 * asserts convergence at each one, which is the "within one full-snapshot cycle" bound.
 */
const FULL_EVERY = 13;

/** The registry, R1-obeying: one global counter, and a removal spends a value of it. */
interface Registry {
  readonly reader: SnapshotReader;
  readonly create: () => void;
  readonly update: (pick: number) => void;
  readonly remove: (pick: number) => void;
  readonly active: () => ReadonlyMap<string, number>;
}

function registry(): Registry {
  let counter = 0;
  let created = 0;
  const members = new Map<string, ActiveEventRow>();
  const nth = (pick: number): string | undefined => [...members.keys()].sort()[pick % members.size];
  return {
    reader: {
      readActiveSet: (afterSeq) =>
        Promise.resolve({
          maxSeq: counter,
          events: [...members.values()]
            .filter((row) => row.seq > afterSeq)
            .sort((a, b) => a.seq - b.seq),
        }),
      readSourceObservations: () => Promise.resolve([]),
    },
    create: () => {
      counter += 1;
      created += 1;
      // Ids are never reused, so "the client holds an id the server removed" can only
      // mean a missed removal, never a legitimate re-creation.
      const publicId = `fw-2026-${String(created).padStart(6, '0')}`;
      members.set(publicId, activeRow({ publicId, seq: counter }));
    },
    update: (pick) => {
      const id = nth(pick);
      if (id === undefined) return;
      counter += 1;
      members.set(id, activeRow({ publicId: id, seq: counter }));
    },
    remove: (pick) => {
      const id = nth(pick);
      if (id === undefined) return;
      // R1: the removal moves the mark although nothing it returns carries the new value.
      counter += 1;
      members.delete(id);
    },
    active: () => new Map([...members].map(([id, row]) => [id, row.seq])),
  };
}

type Slot = 'full' | 'cursor';

interface SnapshotBody {
  readonly partial: boolean;
  readonly max_seq: number;
  readonly features: readonly { readonly id: string; readonly properties: { seq: number } }[];
}

/** The reconciler's rules, as small as the property allows. */
interface Client {
  readonly held: Map<string, number>;
  poll(app: FastifyInstance, full: boolean): Promise<number>;
}

function client(slots: 'two' | 'one'): Client {
  const held = new Map<string, number>();
  const tags: Record<Slot, string | null> = { full: null, cursor: null };
  let mark = 0;
  const slotFor = (full: boolean): Slot => (slots === 'one' ? 'full' : full ? 'full' : 'cursor');

  return {
    held,
    async poll(app, full) {
      const slot = slotFor(full);
      const tag = tags[slot];
      const response = await app.inject({
        method: 'GET',
        url: full ? SNAPSHOT_PATH : `${SNAPSHOT_PATH}?${CURSOR_PARAM}=${String(mark)}`,
        headers: tag === null ? {} : { 'if-none-match': tag },
      });
      if (response.statusCode === 304) return 304;
      expect(response.statusCode).toBe(200);
      tags[slot] = response.headers.etag as string;

      const body = response.json<SnapshotBody>();
      const listed = new Set<string>();
      for (const feature of body.features) {
        listed.add(feature.id);
        const stored = held.get(feature.id);
        if (stored === undefined || feature.properties.seq > stored) {
          held.set(feature.id, feature.properties.seq);
        }
      }
      if (!body.partial) {
        for (const [id, seq] of [...held]) {
          if (!listed.has(id) && body.max_seq > seq) held.delete(id);
        }
      }
      mark = Math.max(mark, body.max_seq);
      return 200;
    },
  };
}

function app(reader: SnapshotReader): FastifyInstance {
  const instance = Fastify({ logger: false });
  registerSnapshotRoute(instance, { reader, clock: new VirtualClock(NOW), sources: [] });
  return instance;
}

const operation = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: 'create' as const, pick: 0 }) },
  { weight: 3, arbitrary: fc.nat(7).map((pick) => ({ kind: 'update' as const, pick })) },
  { weight: 3, arbitrary: fc.nat(7).map((pick) => ({ kind: 'remove' as const, pick })) },
);

/** Between polls: usually quiet, as a real registry is at most instants. */
const step = fc.array(operation, { maxLength: 3 });

describe('S15 (server half) — a cursor-only client converges on the real route', () => {
  it('holds exactly the active set after every full fetch, whatever the interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 60 }), async (steps) => {
        const server = registry();
        const origin = app(server.reader);
        const polling = client('two');
        try {
          for (const [index, ops] of steps.entries()) {
            for (const op of ops) server[op.kind](op.pick);
            const full = index % FULL_EVERY === 0;
            await polling.poll(origin, full);
            if (full) {
              expect(new Map(polling.held)).toEqual(server.active());
            }
            // Between fulls the client may lag, but only behind: it never holds a member
            // at a seq the server has not reached, and a partial never deletes.
            for (const [id, seq] of polling.held) {
              const current = server.active().get(id);
              if (current !== undefined) expect(seq).toBeLessThanOrEqual(current);
            }
          }
          // One more full closes the cycle the last steps opened.
          await polling.poll(origin, true);
          expect(new Map(polling.held)).toEqual(server.active());
        } finally {
          await origin.close();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('delivers a removal that no cursor response can carry on the next full fetch', async () => {
    const server = registry();
    const origin = app(server.reader);
    const polling = client('two');
    server.create();
    server.create();
    expect(await polling.poll(origin, true)).toBe(200);
    server.remove(0);
    // The cursor sees the mark move and nothing else — a removal has no row to send.
    expect(await polling.poll(origin, false)).toBe(200);
    expect(polling.held.size).toBe(2);
    expect(await polling.poll(origin, true)).toBe(200);
    expect(new Map(polling.held)).toEqual(server.active());
    await origin.close();
  });
});

describe('the ETag slots are load-bearing (pinned hazard, see module comment)', () => {
  it('lets a one-slot client revalidate its full fetch with a cursor tag and miss the removal', async () => {
    const server = registry();
    const origin = app(server.reader);
    const naive = client('one');
    server.create();
    server.create();
    expect(await naive.poll(origin, true)).toBe(200);
    server.remove(0);
    expect(await naive.poll(origin, false)).toBe(200);
    // The full fetch now carries `"v1-<post-removal mark>"`, learned from a partial body,
    // and the route cannot tell: same tag, same answer.
    expect(await naive.poll(origin, true)).toBe(304);
    expect(naive.held.size).toBe(2);
    expect(server.active().size).toBe(1);
    await origin.close();
  });
});
