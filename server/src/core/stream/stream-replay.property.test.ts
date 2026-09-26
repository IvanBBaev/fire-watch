/**
 * The E2 done-when (TASKS): replay, gap and reset as properties (ADR-003 D1 ring buffer,
 * D3 rules 2–4).
 *
 * The frames a stream sends are only useful if a client that missed some of them can be
 * brought back to the truth — or told that it cannot. So the headline property is stated
 * from the client's side: *a D3 client that took a snapshot at any point, reconnected with
 * that point as `Last-Event-ID`, and applied whatever the ring gave it, either holds
 * exactly the registry's active set or has `needsSnapshot` raised.* Everything below the
 * headline pins the pieces that property is not allowed to reach its conclusion by
 * damaging: the ring's floor/latest/size arithmetic, the exact classification of a cursor
 * into replay / too_old / unknown, idempotence of a replay, and that the stream is not
 * trivially "always flag" — a client that missed nothing is not told to snapshot.
 *
 * The simulated client below mirrors `web/src/core/store/reconciler.ts` (E5 owns the real
 * one): upsert iff `seq > stored.seq`, never delete on a delta, `event.merged` writes a
 * tombstone, a frame `id > maxSeq + 1` raises `needsSnapshot`, `reset` clears everything.
 * Frames are applied one at a time, as `EventSource` delivers them. One rule beyond the
 * reconciler's: a `freshness` frame whose `max_seq` is above the client's own mark also
 * raises `needsSnapshot` — that is what the frame's `max_seq` is for (D2, frames.ts).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LIFECYCLE_STATES, type LifecycleState } from '@fire-watch/contracts';

import type { ChangeReader, ChangeRow } from '../ports/change-reader.js';
import { VirtualClock } from '../ports/clock.js';
import type { SnapshotReader } from '../ports/snapshot-reader.js';
import { isActiveMember } from './change-projector.js';
import { createFrameRing } from './frame-ring.js';
import type { EventFrame, FreshnessFrameData } from './frames.js';
import { createStreamPump } from './stream-pump.js';
import { T0, changeRow, frame } from './test-rows.js';

/** Small on purpose: repeated ids are where the version rule and the tombstone earn their keep. */
const ID_POOL = ['a', 'b', 'c', 'd'] as const;

/** Mostly contiguous seqs, sometimes a hole — holes are normal on the real wire. */
const seqStep = fc.oneof(
  { arbitrary: fc.constant(1), weight: 6 },
  { arbitrary: fc.integer({ min: 2, max: 4 }), weight: 1 },
);

function seqsFrom(start: number, steps: readonly number[]): number[] {
  const out: number[] = [];
  let seq = start;
  for (const step of steps) {
    seq += step;
    out.push(seq);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Ring arithmetic

const ringCase = fc.record({
  floor: fc.nat(50),
  capacity: fc.integer({ min: 1, max: 8 }),
  steps: fc.array(seqStep, { maxLength: 30 }),
});

describe('the ring', () => {
  it('keeps floor, latest and size exact under any push sequence', () => {
    fc.assert(
      fc.property(ringCase, ({ floor, capacity, steps }) => {
        const ids = seqsFrom(floor, steps);
        const ring = createFrameRing({ capacity, floor });
        for (const id of ids) ring.push(frame(id));
        expect(ring.size).toBe(Math.min(ids.length, capacity));
        expect(ring.latest).toBe(ids.at(-1) ?? floor);
        const evicted = ids.length - capacity;
        expect(ring.floor).toBe(evicted > 0 ? ids[evicted - 1] : floor);
      }),
    );
  });

  it('classifies every cursor as replay iff within [floor, latest], too_old below, unknown above', () => {
    fc.assert(
      fc.property(ringCase, fc.nat(200), ({ floor, capacity, steps }, cursor) => {
        const ids = seqsFrom(floor, steps);
        const ring = createFrameRing({ capacity, floor });
        for (const id of ids) ring.push(frame(id));
        const outcome = ring.replayAfter(cursor);
        if (cursor < ring.floor) {
          expect(outcome).toEqual({ kind: 'reset', reason: 'too_old' });
        } else if (cursor > ring.latest) {
          expect(outcome).toEqual({ kind: 'reset', reason: 'unknown' });
        } else {
          // Exactly the retained ids above the cursor, in order.
          const retained = ids.slice(Math.max(0, ids.length - capacity));
          expect(outcome).toEqual({
            kind: 'replay',
            frames: retained.filter((id) => id > cursor).map((id) => frame(id)),
          });
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------
// The D3 client

interface ClientEvent {
  readonly seq: number;
  readonly status: LifecycleState;
  readonly mergedInto: string | null;
}

interface ClientState {
  readonly events: ReadonlyMap<string, ClientEvent>;
  readonly maxSeq: number;
  readonly needsSnapshot: boolean;
}

function applyFrame(state: ClientState, incoming: EventFrame): ClientState {
  const { properties } = incoming.data.feature;
  const stored = state.events.get(properties.id);
  const events = new Map(state.events);
  if (stored === undefined || properties.seq > stored.seq) {
    events.set(properties.id, {
      seq: properties.seq,
      status: properties.status,
      mergedInto: properties.merged_into,
    });
  }
  const gap = incoming.id > state.maxSeq + 1;
  return {
    events,
    maxSeq: Math.max(state.maxSeq, incoming.id),
    needsSnapshot: state.needsSnapshot || gap,
  };
}

function applyFreshness(state: ClientState, data: FreshnessFrameData): ClientState {
  return data.max_seq > state.maxSeq ? { ...state, needsSnapshot: true } : state;
}

const RESET: ClientState = { events: new Map(), maxSeq: 0, needsSnapshot: true };

/** The live set a client shows: tombstones are held but not members (D3 rule 2). */
function liveOf(events: ReadonlyMap<string, ClientEvent>): Map<string, [number, LifecycleState]> {
  const live = new Map<string, [number, LifecycleState]>();
  for (const [id, event] of events) {
    if (event.mergedInto === null) live.set(id, [event.seq, event.status]);
  }
  return live;
}

// ---------------------------------------------------------------------------------------
// The registry

interface Change {
  readonly id: (typeof ID_POOL)[number];
  readonly status: LifecycleState;
  /** Where the row lands: on the map, off it, or merged into another id. */
  readonly fate: 'map' | 'feed' | 'archive' | 'invalidated' | 'merged';
  readonly survivor: (typeof ID_POOL)[number];
}

const changeArb: fc.Arbitrary<Change> = fc.record({
  id: fc.constantFrom(...ID_POOL),
  status: fc.constantFrom(...LIFECYCLE_STATES),
  fate: fc.oneof(
    { arbitrary: fc.constant('map' as const), weight: 5 },
    {
      arbitrary: fc.constantFrom('feed' as const, 'archive' as const, 'invalidated' as const),
      weight: 1,
    },
    { arbitrary: fc.constant('merged' as const), weight: 1 },
  ),
  survivor: fc.constantFrom(...ID_POOL),
});

function rowOf(change: Change, seq: number): ChangeRow {
  const base = { publicId: change.id, seq, status: change.status };
  switch (change.fate) {
    case 'map':
      return changeRow(base);
    case 'feed':
    case 'archive':
      return changeRow({ ...base, displayTier: change.fate });
    case 'invalidated':
      return changeRow({ ...base, invalidated: true });
    case 'merged':
      return changeRow({
        ...base,
        mergedInto: change.survivor === change.id ? 'x' : change.survivor,
      });
  }
}

/** The active set as the registry holds it after every row with `seq <= upTo`. */
function truthAt(rows: readonly ChangeRow[], upTo: number): Map<string, [number, LifecycleState]> {
  const latest = new Map<string, ChangeRow>();
  for (const row of rows) if (row.seq <= upTo) latest.set(row.publicId, row);
  const live = new Map<string, [number, LifecycleState]>();
  for (const [id, row] of latest) if (isActiveMember(row)) live.set(id, [row.seq, row.status]);
  return live;
}

interface Registry {
  /** Rows the pump seeds from (all before the stream started) — what `readActiveSet` returns. */
  readonly seedRows: readonly ChangeRow[];
  readonly seedSeq: number;
  /** Rows the stream will see, ascending, all above `seedSeq`. */
  readonly streamed: readonly ChangeRow[];
}

const registryArb: fc.Arbitrary<Registry> = fc
  .record({
    seed: fc.array(fc.tuple(changeArb, seqStep), { maxLength: 6 }),
    streamed: fc.array(fc.tuple(changeArb, seqStep), { maxLength: 24 }),
  })
  .map(({ seed, streamed }) => {
    const seedSeqs = seqsFrom(
      0,
      seed.map(([, step]) => step),
    );
    const seedRows = seed.map(([change], index) => rowOf(change, seedSeqs[index] ?? 0));
    const seedSeq = seedSeqs.at(-1) ?? 0;
    const streamedSeqs = seqsFrom(
      seedSeq,
      streamed.map(([, step]) => step),
    );
    return {
      seedRows,
      seedSeq,
      streamed: streamed.map(([change], index) => rowOf(change, streamedSeqs[index] ?? 0)),
    };
  });

interface Driven {
  readonly pump: ReturnType<typeof createStreamPump>;
  readonly rows: readonly ChangeRow[];
  readonly emitted: readonly EventFrame[];
}

/** Runs the pump over the registry in whatever batch shape the case asks for. */
async function drive(
  registry: Registry,
  ringCapacity: number,
  batchLimit: number,
  maxBatchesPerTick: number,
): Promise<Driven> {
  const rows = [...registry.seedRows, ...registry.streamed];
  const maxSeq = rows.at(-1)?.seq ?? 0;
  const seedTruth = truthAt(registry.seedRows, registry.seedSeq);
  const snapshotReader: SnapshotReader = {
    readActiveSet: () =>
      Promise.resolve({
        maxSeq: registry.seedSeq,
        events: registry.seedRows.filter((row) => seedTruth.get(row.publicId)?.[0] === row.seq),
      }),
    readSourceObservations: () => Promise.resolve([]),
  };
  const changeReader: ChangeReader = {
    readChangesSince: (afterSeq, limit) =>
      Promise.resolve({
        maxSeq,
        rows: registry.streamed.filter((row) => row.seq > afterSeq).slice(0, limit),
      }),
  };
  const emitted: EventFrame[] = [];
  const pump = createStreamPump({
    snapshotReader,
    changeReader,
    hub: {
      broadcast: (chunk) => {
        const match = /^id: (\d+)\n/.exec(chunk);
        if (match !== null) {
          const outcome = pump.replayAfter(Number(match[1]) - 1);
          const last = outcome.kind === 'replay' ? outcome.frames[0] : undefined;
          if (last !== undefined) emitted.push(last);
        }
      },
    },
    clock: new VirtualClock(T0),
    sources: [],
    ringCapacity,
    batchLimit,
    maxBatchesPerTick,
    freshnessIntervalMs: 1,
  });
  const ticks = Math.ceil(registry.streamed.length / (batchLimit * maxBatchesPerTick)) + 2;
  for (let i = 0; i < ticks; i += 1) await pump.tick();
  return { pump, rows, emitted };
}

/** A cursor above anything the registry ever drew — a client from another registry. */
const BEYOND = -1;

const driveCase = fc.record({
  registry: registryArb,
  ringCapacity: fc.integer({ min: 1, max: 12 }),
  batchLimit: fc.integer({ min: 1, max: 5 }),
  maxBatchesPerTick: fc.integer({ min: 1, max: 3 }),
  /** Which registry instant the client snapshotted at: an index into the seqs, or beyond. */
  reconnectAt: fc.oneof(
    { arbitrary: fc.nat(40), weight: 9 },
    { arbitrary: fc.constant(BEYOND), weight: 1 },
  ),
});

function cursorOf(registry: Registry, reconnectAt: number): number {
  const marks = [registry.seedSeq, ...registry.streamed.map((row) => row.seq)];
  if (reconnectAt === BEYOND) return (marks.at(-1) ?? 0) + 1;
  return marks[reconnectAt % marks.length] ?? 0;
}

describe('a D3 client through any reconnect', () => {
  it('ends on the registry’s active set, or with needsSnapshot raised — never silently wrong', async () => {
    await fc.assert(
      fc.asyncProperty(
        driveCase,
        async ({ registry, ringCapacity, batchLimit, maxBatchesPerTick, reconnectAt }) => {
          const { pump, rows, emitted } = await drive(
            registry,
            ringCapacity,
            batchLimit,
            maxBatchesPerTick,
          );
          const cursor = cursorOf(registry, reconnectAt);

          // The client snapshotted at `cursor` and connects with it as Last-Event-ID.
          let client: ClientState = {
            events: truthMap(truthAt(rows, cursor)),
            maxSeq: cursor,
            needsSnapshot: false,
          };
          const outcome = pump.replayAfter(cursor);
          if (outcome.kind === 'reset') {
            client = RESET;
          } else {
            for (const f of outcome.frames) client = applyFrame(client, f);
          }
          const freshness = pump.freshness();
          if (freshness?.event === 'freshness') client = applyFreshness(client, freshness.data);

          const truth = truthAt(rows, Number.MAX_SAFE_INTEGER);
          const converged = mapsEqual(liveOf(client.events), truth);
          expect(converged || client.needsSnapshot).toBe(true);

          // Not trivially "always flag": a client that missed nothing is not sent to snapshot.
          const missedNothing =
            outcome.kind === 'replay' &&
            isContiguousFrom(
              cursor,
              registry.streamed.filter((row) => row.seq > cursor),
            ) &&
            registry.streamed
              .filter((row) => row.seq > cursor)
              .every((row) => emitted.some((f) => f.id === row.seq));
          if (missedNothing) {
            expect(client.needsSnapshot).toBe(false);
            expect(converged).toBe(true);
          }
        },
      ),
    );
  });

  it('applies a replay idempotently and never regresses a seq', async () => {
    await fc.assert(
      fc.asyncProperty(
        driveCase,
        async ({ registry, ringCapacity, batchLimit, maxBatchesPerTick, reconnectAt }) => {
          const { pump, rows } = await drive(registry, ringCapacity, batchLimit, maxBatchesPerTick);
          const cursor = cursorOf(registry, reconnectAt);
          const outcome = pump.replayAfter(cursor);
          if (outcome.kind !== 'replay') return;

          const start: ClientState = {
            events: truthMap(truthAt(rows, cursor)),
            maxSeq: cursor,
            needsSnapshot: false,
          };
          let once = start;
          for (const f of outcome.frames) once = applyFrame(once, f);
          let twice = once;
          for (const f of outcome.frames) twice = applyFrame(twice, f);
          expect(mapsEqual(liveOf(twice.events), liveOf(once.events))).toBe(true);
          expect(twice.maxSeq).toBe(once.maxSeq);

          for (const [id, before] of start.events) {
            const after = once.events.get(id);
            expect(after, id).toBeDefined();
            expect(after?.seq ?? 0, id).toBeGreaterThanOrEqual(before.seq);
          }
          expect(once.maxSeq).toBeGreaterThanOrEqual(start.maxSeq);
        },
      ),
    );
  });

  it('emits exactly one frame per streamed row that lands on the map or is merged, with id = seq', async () => {
    await fc.assert(
      fc.asyncProperty(driveCase, async ({ registry, batchLimit, maxBatchesPerTick }) => {
        const { emitted } = await drive(registry, 10_000, batchLimit, maxBatchesPerTick);
        const expected = registry.streamed.filter(
          (row) => row.mergedInto !== null || isActiveMember(row),
        );
        expect(emitted.map((f) => f.id)).toEqual(expected.map((row) => row.seq));
        for (const f of emitted) expect(f.data.feature.properties.seq).toBe(f.id);
      }),
    );
  });
});

function truthMap(truth: ReadonlyMap<string, [number, LifecycleState]>): Map<string, ClientEvent> {
  return new Map([...truth].map(([id, [seq, status]]) => [id, { seq, status, mergedInto: null }]));
}

function mapsEqual(
  left: ReadonlyMap<string, readonly [number, LifecycleState]>,
  right: ReadonlyMap<string, readonly [number, LifecycleState]>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, [seq, status]] of left) {
    const other = right.get(id);
    if (other === undefined || other[0] !== seq || other[1] !== status) return false;
  }
  return true;
}

/** No hole in the seqs after the cursor: every row is the previous seq plus one. */
function isContiguousFrom(cursor: number, rows: readonly ChangeRow[]): boolean {
  let expected = cursor + 1;
  for (const row of rows) {
    if (row.seq !== expected) return false;
    expected += 1;
  }
  return true;
}
