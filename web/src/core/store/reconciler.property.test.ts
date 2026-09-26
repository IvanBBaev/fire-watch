/**
 * fast-check properties for the reconciler (ADR-003 D3; the CI-8 family from review 08
 * §5.7.1), in two families.
 *
 * **Algebraic**, over arbitrary — not necessarily truthful — states and messages: no
 * field ever regresses, deltas are idempotent and order-insensitive, replaying any prefix
 * is a no-op, an in-order stream one frame at a time equals the batch, gap detection
 * fires exactly when a seq is skipped, a reset only raises the demand, and the "no
 * explicit buffering" equivalence the module comment promises.
 *
 * **Against a server model**: a random history of creates, updates, merges, un-merges and
 * silent removals under one monotonically increasing global seq, delivered to the client
 * through a random interleaving of in-order frames, lost frames, replays, stale full
 * snapshots, cursor partials, stream marks, resets and 304 confirmations, with tombstone
 * age-out running as the store runs it. Invariants at every step: versions and cursors
 * never regress, no zombies (the client never holds active an event the server had
 * removed or merged by a seq the client has *set* evidence of), no flicker-delete (the
 * client never drops an active event the server still holds in that very version), and
 * replays are reference-equal no-ops; at the end, the S15 obligation — the next fresh full
 * snapshot converges the active set exactly (ADR-003 A1.5).
 *
 * The model keeps the two operating assumptions the design leans on (both ADR-003):
 * full snapshots are polled less often than the CDN caches them, so each one is at least
 * as fresh as the moment the previous one was *delivered* — two distinct stale copies
 * that both predate a change the client already holds never arrive back to back, which
 * is what keeps the two-absence rule from removing a live event; and the safety rhythm
 * (A1.5) delivers a fresh full snapshot at least every {@link SAFETY_EVERY} changes, far
 * inside the 24 h age-out, so a tombstone never expires before a snapshot has settled the
 * stale-create floor past it.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LIFECYCLE_STATES, SCORE_BUCKETS } from '@fire-watch/contracts';

import type { FireEvent, Snapshot } from '../types.js';
import type { ReconcilerState } from './reconciler.js';
import {
  TOMBSTONE_TTL_MS,
  applyConfirmation,
  applyDelta,
  applyReset,
  applySnapshot,
  applyStreamFreshness,
  createInitialReconcilerState,
  expireTombstones,
} from './reconciler.js';

/** Small on purpose: identity collisions are where the seq rule earns its keep. */
const ID_POOL = [
  'fw-2026-u1',
  'fw-2026-u2',
  'fw-2026-u3',
  'fw-2026-u4',
  'fw-2026-u5',
  'fw-2026-u6',
] as const;

const EPOCH_MS = Date.UTC(2026, 6, 1);

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${String(index)}`);
  return item;
}

function sortedEntries<V>(map: ReadonlyMap<string, V>): (readonly [string, V])[] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Map iteration order is insertion order — normalize before deep comparison. */
function normalize(state: ReconcilerState): {
  events: readonly (readonly [string, FireEvent])[];
  maxSeq: number;
  settledSeq: number;
  lastSnapshotAt: string | null;
  needsSnapshot: boolean;
  absences: readonly (readonly [string, number])[];
  tombstonedAt: readonly (readonly [string, number])[];
} {
  return {
    events: sortedEntries(state.events),
    maxSeq: state.maxSeq,
    settledSeq: state.settledSeq,
    lastSnapshotAt: state.lastSnapshotAt,
    needsSnapshot: state.needsSnapshot,
    absences: sortedEntries(state.absences),
    tombstonedAt: sortedEntries(state.tombstonedAt),
  };
}

/** What the map and the list see of an event: identity, version, tombstone or not. */
function triples(
  events: ReadonlyMap<string, FireEvent>,
): (readonly [string, number, string | null])[] {
  return sortedEntries(events).map(([id, event]) => [id, event.seq, event.mergedInto] as const);
}

/** The active set — what the map draws — as `[id, seq]` pairs. */
function activePairs(events: ReadonlyMap<string, FireEvent>): (readonly [string, number])[] {
  return sortedEntries(events)
    .filter(([, event]) => event.mergedInto === null)
    .map(([id, event]) => [id, event.seq] as const);
}

function expectNoRegression(before: ReconcilerState, after: ReconcilerState): void {
  for (const [id, stored] of before.events) {
    const kept = after.events.get(id);
    if (kept !== undefined) expect(kept.seq).toBeGreaterThanOrEqual(stored.seq);
  }
  expect(after.maxSeq).toBeGreaterThanOrEqual(before.maxSeq);
  expect(after.settledSeq).toBeGreaterThanOrEqual(before.settledSeq);
  expect(after.settledSeq).toBeLessThanOrEqual(after.maxSeq);
  if (before.lastSnapshotAt !== null) {
    expect(after.lastSnapshotAt).not.toBeNull();
    expect(Date.parse(after.lastSnapshotAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(before.lastSnapshotAt),
    );
  }
}

// ---------------------------------------------------------------------------------------
// Algebraic arbitraries: arbitrary events, snapshots, sessions and messages.
// ---------------------------------------------------------------------------------------

const isoArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 60 * 24 * 60 })
  .map((minutes) => new Date(EPOCH_MS + minutes * 60_000).toISOString());

const fireEventArb: fc.Arbitrary<FireEvent> = fc.record({
  id: fc.constantFrom(...ID_POOL),
  seq: fc.integer({ min: 1, max: 40 }),
  status: fc.constantFrom(...LIFECYCLE_STATES),
  scoreBucket: fc.constantFrom(...SCORE_BUCKETS),
  mergedInto: fc.option(fc.constantFrom(...ID_POOL), { nil: null }),
  lon: fc.double({ min: 22, max: 29, noNaN: true }),
  lat: fc.double({ min: 41, max: 44.5, noNaN: true }),
  firstObservedAt: isoArb,
  lastObservedAt: isoArb,
  detectionCount: fc.integer({ min: 1, max: 500 }),
  placeNameBg: fc.constantFrom('Харманли', 'Рила', 'Сакар'),
  placeNameEn: fc.constantFrom('Harmanli', 'Rila', 'Sakar'),
  areaHa: fc.option(fc.double({ min: 0, max: 5_000, noNaN: true }), { nil: null }),
  nextPassWindow: fc.option(fc.record({ start: isoArb, end: isoArb }), { nil: null }),
});

/** A snapshot's event list is unique by id — it is a set, not a stream. */
const snapshotEventsArb = fc.uniqueArray(fireEventArb, {
  selector: (event) => event.id,
  maxLength: ID_POOL.length,
});

function snapshotArb(partial: boolean): fc.Arbitrary<Snapshot> {
  return fc
    .record({
      events: snapshotEventsArb,
      generatedAt: isoArb,
      seqSlack: fc.integer({ min: 0, max: 5 }),
    })
    .map(({ events, generatedAt, seqSlack }) => ({
      schemaVersion: 1,
      generatedAt,
      // maxSeq must cover every carried event's seq; the slack models changes the
      // snapshot knows happened to events outside its own list.
      maxSeq: Math.max(0, ...events.map((event) => event.seq)) + seqSlack,
      partial,
      events,
      sources: [],
    }));
}

type SessionStep =
  | {
      readonly kind: 'delta';
      readonly events: readonly FireEvent[];
      readonly generatedAt: string | undefined;
    }
  | { readonly kind: 'partial'; readonly snapshot: Snapshot }
  | { readonly kind: 'mark'; readonly maxSeq: number; readonly generatedAt: string }
  | { readonly kind: 'reset' };

/** What a live session throws at a booted client, weighted towards deltas. */
const sessionStepArb: fc.Arbitrary<SessionStep> = fc.oneof(
  {
    arbitrary: fc
      .record({
        events: fc.array(fireEventArb, { maxLength: 4 }),
        generatedAt: fc.option(isoArb, { nil: undefined }),
      })
      .map((step) => ({ kind: 'delta', ...step }) as const),
    weight: 4,
  },
  {
    arbitrary: snapshotArb(true).map((snapshot) => ({ kind: 'partial', snapshot }) as const),
    weight: 2,
  },
  {
    arbitrary: fc
      .record({ maxSeq: fc.integer({ min: 0, max: 45 }), generatedAt: isoArb })
      .map((step) => ({ kind: 'mark', ...step }) as const),
    weight: 1,
  },
  { arbitrary: fc.constant({ kind: 'reset' } as const), weight: 1 },
);

function runSessionStep(state: ReconcilerState, step: SessionStep): ReconcilerState {
  switch (step.kind) {
    case 'delta':
      return applyDelta(state, step.events, step.generatedAt);
    case 'partial':
      return applySnapshot(state, step.snapshot);
    case 'mark':
      return applyStreamFreshness(state, step.maxSeq, step.generatedAt);
    case 'reset':
      return applyReset(state);
  }
}

/** A reachable state: a full snapshot then a short live session, gaps and demands included. */
const stateArb: fc.Arbitrary<ReconcilerState> = fc
  .tuple(snapshotArb(false), fc.array(sessionStepArb, { maxLength: 4 }))
  .map(([snapshot, steps]) =>
    steps.reduce(
      (state, step) => runSessionStep(state, step),
      applySnapshot(createInitialReconcilerState(), snapshot),
    ),
  );

type Message =
  | SessionStep
  | { readonly kind: 'full'; readonly snapshot: Snapshot }
  | { readonly kind: 'confirm'; readonly generatedAt: string }
  | { readonly kind: 'expire'; readonly serverNowMs: number };

/** Every entry point of the reconciler, so a property can range over all of them. */
const messageArb: fc.Arbitrary<Message> = fc.oneof(
  sessionStepArb,
  snapshotArb(false).map((snapshot) => ({ kind: 'full', snapshot }) as const),
  isoArb.map((generatedAt) => ({ kind: 'confirm', generatedAt }) as const),
  fc
    .integer({ min: 0, max: 60 * 24 * 60 })
    .map((minutes) => ({ kind: 'expire', serverNowMs: EPOCH_MS + minutes * 60_000 }) as const),
);

function applyMessage(state: ReconcilerState, message: Message): ReconcilerState {
  switch (message.kind) {
    case 'full':
      return applySnapshot(state, message.snapshot);
    case 'confirm':
      return applyConfirmation(state, message.generatedAt);
    case 'expire':
      return expireTombstones(state, message.serverNowMs);
    default:
      return runSessionStep(state, message);
  }
}

/**
 * A delta batch plus a permutation of it. Unique by `(id, seq)`: the seq IS the
 * per-event version (ADR-003 A1.4), so two different payloads sharing one version
 * cannot occur on the wire and would make order-insensitivity meaninglessly false.
 */
const batchWithPermutationArb = fc
  .uniqueArray(fireEventArb, {
    selector: (event) => `${event.id}:${String(event.seq)}`,
    maxLength: 8,
  })
  .chain((batch) =>
    fc.tuple(
      fc.constant(batch),
      fc.shuffledSubarray(batch, { minLength: batch.length, maxLength: batch.length }),
    ),
  );

/** A state paired with a batch of stale copies of its own events (mutated content). */
const stateWithStaleBatchArb: fc.Arbitrary<[ReconcilerState, FireEvent[]]> = stateArb.chain(
  (state) => {
    const stored = [...state.events.values()];
    if (stored.length === 0) {
      return fc.tuple(fc.constant(state), fc.constant<FireEvent[]>([]));
    }
    const staleEventArb = fc
      .record({
        index: fc.integer({ min: 0, max: stored.length - 1 }),
        seqDrop: fc.integer({ min: 0, max: 5 }),
        bump: fc.integer({ min: 1, max: 100 }),
      })
      .map(({ index, seqDrop, bump }) => {
        const source = at(stored, index);
        return {
          ...source,
          seq: Math.max(1, source.seq - seqDrop),
          detectionCount: source.detectionCount + bump,
        };
      });
    return fc.tuple(fc.constant(state), fc.array(staleEventArb, { maxLength: 6 }));
  },
);

/** Deterministic minimal event for seq-focused properties; `detectionCount` = seq so copies differ. */
function eventAt(id: string, seq: number, mergedInto: string | null = null): FireEvent {
  return {
    id,
    seq,
    status: mergedInto === null ? 'active' : 'archived',
    scoreBucket: 'likely',
    mergedInto,
    lon: 25.3,
    lat: 42.7,
    firstObservedAt: '2026-08-01T00:00:00.000Z',
    lastObservedAt: '2026-08-01T00:00:00.000Z',
    detectionCount: seq,
    placeNameBg: 'Рила',
    placeNameEn: 'Rila',
    areaHa: null,
    nextPassWindow: null,
  };
}

function eventAtSeq(seq: number): FireEvent {
  return eventAt(at(ID_POOL, seq % ID_POOL.length), seq);
}

/**
 * A state, a full snapshot no older than its cursor, and a delta batch entirely newer
 * than the snapshot — the shape in which "apply now" and "buffer until the snapshot
 * lands" must agree.
 */
const bufferingCaseArb: fc.Arbitrary<{
  state: ReconcilerState;
  snapshot: Snapshot;
  delta: readonly FireEvent[];
  generatedAt: string;
}> = stateArb.chain((state) =>
  snapshotArb(false)
    .map((snapshot) => ({ ...snapshot, maxSeq: Math.max(snapshot.maxSeq, state.maxSeq) }))
    .chain((snapshot) =>
      fc.record({
        state: fc.constant(state),
        snapshot: fc.constant(snapshot),
        delta: fc
          .uniqueArray(fireEventArb, {
            selector: (event) => `${event.id}:${String(event.seq)}`,
            maxLength: 6,
          })
          .map((events) => events.map((event) => ({ ...event, seq: snapshot.maxSeq + event.seq }))),
        generatedAt: isoArb,
      }),
    ),
);

/** A state and an in-order stream above its cursor: strictly increasing seqs, gaps allowed. */
const stateWithStreamArb: fc.Arbitrary<[ReconcilerState, FireEvent[]]> = stateArb.chain((state) =>
  fc
    .array(
      fc.record({
        id: fc.constantFrom(...ID_POOL),
        skip: fc.integer({ min: 0, max: 2 }),
        mergedInto: fc.option(fc.constantFrom(...ID_POOL), { nil: null }),
      }),
      { maxLength: 8 },
    )
    .map((seeds) => {
      let seq = state.maxSeq;
      const stream = seeds.map((seed) => {
        seq += 1 + seed.skip;
        return eventAt(seed.id, seq, seed.mergedInto);
      });
      return [state, stream] as [ReconcilerState, FireEvent[]];
    }),
);

// ---------------------------------------------------------------------------------------
// The server model.
// ---------------------------------------------------------------------------------------

/** Server "time": one change every two hours, so the 24 h age-out spans a dozen seqs. */
const SEQ_MS = 2 * 60 * 60 * 1000;
/** The safety rhythm, in changes: a fresh full snapshot at least this often (A1.5). */
const SAFETY_EVERY = 6;

function msAt(seq: number): number {
  return EPOCH_MS + seq * SEQ_MS;
}

function isoAt(seq: number, offsetMs = 0): string {
  return new Date(msAt(seq) + offsetMs).toISOString();
}

type OpKind = 'create' | 'update' | 'merge' | 'unmerge' | 'remove';

interface OpSeed {
  readonly id: string;
  readonly kind: OpKind;
  /** Distance to the merge survivor in the pool — never the event itself. */
  readonly intoOffset: number;
}

/** One change on the server: the frame it emitted, or `null` for a silent removal. */
interface HistoryStep {
  readonly seq: number;
  readonly id: string;
  readonly frame: FireEvent | null;
}

interface Server {
  seq: number;
  readonly present: Map<string, FireEvent>;
  readonly steps: HistoryStep[];
}

/**
 * Apply a seed to the server. Seeds are normalized against what the server holds, so
 * every history is legal: an unknown or removed id is created, a removal emits nothing,
 * a merge names a survivor other than the event itself, and un-merging an active event
 * or merging a tombstone degrade to a plain update of the current form.
 */
function step(server: Server, seed: OpSeed): void {
  const seq = ++server.seq;
  const stored = server.present.get(seed.id);
  let frame: FireEvent | null;
  if (stored === undefined) {
    frame = eventAt(seed.id, seq);
  } else if (seed.kind === 'remove') {
    frame = null;
  } else if (seed.kind === 'merge') {
    const survivor =
      stored.mergedInto ??
      at(
        ID_POOL,
        (ID_POOL.indexOf(seed.id as (typeof ID_POOL)[number]) + seed.intoOffset) % ID_POOL.length,
      );
    frame = eventAt(seed.id, seq, survivor);
  } else if (seed.kind === 'unmerge' || stored.mergedInto === null) {
    frame = eventAt(seed.id, seq);
  } else {
    frame = eventAt(seed.id, seq, stored.mergedInto);
  }
  if (frame === null) server.present.delete(seed.id);
  else server.present.set(seed.id, frame);
  server.steps.push({ seq, id: seed.id, frame });
}

/** The server's event table as it stood right after change `seq`. */
function presentAt(steps: readonly HistoryStep[], seq: number): ReadonlyMap<string, FireEvent> {
  const present = new Map<string, FireEvent>();
  for (const change of steps) {
    if (change.seq > seq) break;
    if (change.frame === null) present.delete(change.id);
    else present.set(change.id, change.frame);
  }
  return present;
}

function activeAt(steps: readonly HistoryStep[], seq: number): ReadonlyMap<string, FireEvent> {
  return new Map([...presentAt(steps, seq)].filter(([, event]) => event.mergedInto === null));
}

/** A full snapshot as the origin served it at `seq`: every active event, tombstones optionally. */
function fullSnapshotAt(
  steps: readonly HistoryStep[],
  seq: number,
  withTombstones: boolean,
): Snapshot {
  const events = [...presentAt(steps, seq).values()].filter(
    (event) => withTombstones || event.mergedInto === null,
  );
  return {
    schemaVersion: 1,
    generatedAt: isoAt(seq),
    maxSeq: seq,
    partial: false,
    events,
    sources: [],
  };
}

/** A cursor response (`?updated_after_seq=cursor`), always fresh: every present event changed since. */
function partialSince(server: Server, cursor: number): Snapshot {
  const events = [...server.present.values()].filter((event) => event.seq > cursor);
  return {
    schemaVersion: 1,
    generatedAt: isoAt(server.seq),
    maxSeq: server.seq,
    partial: true,
    events,
    sources: [],
  };
}

type Delivery =
  | { readonly kind: 'frame' }
  | { readonly kind: 'drop' }
  | { readonly kind: 'replay'; readonly pick: number }
  | { readonly kind: 'full'; readonly staleness: number; readonly withTombstones: boolean }
  | { readonly kind: 'partial' }
  | { readonly kind: 'mark' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'confirm' };

interface Action {
  /** Changes the server makes before this delivery. */
  readonly advance: number;
  readonly delivery: Delivery;
}

interface Scenario {
  readonly ops: readonly OpSeed[];
  readonly actions: readonly Action[];
  readonly finalWithTombstones: boolean;
}

const opSeedArb: fc.Arbitrary<OpSeed> = fc.record({
  id: fc.constantFrom(...ID_POOL),
  kind: fc.constantFrom<OpKind>('create', 'update', 'merge', 'unmerge', 'remove'),
  intoOffset: fc.integer({ min: 1, max: ID_POOL.length - 1 }),
});

const deliveryArb: fc.Arbitrary<Delivery> = fc.oneof(
  { arbitrary: fc.constant({ kind: 'frame' } as const), weight: 6 },
  { arbitrary: fc.constant({ kind: 'drop' } as const), weight: 1 },
  { arbitrary: fc.nat(30).map((pick) => ({ kind: 'replay', pick }) as const), weight: 2 },
  {
    arbitrary: fc
      .record({ staleness: fc.nat(6), withTombstones: fc.boolean() })
      .map((seed) => ({ kind: 'full', ...seed }) as const),
    weight: 3,
  },
  { arbitrary: fc.constant({ kind: 'partial' } as const), weight: 2 },
  { arbitrary: fc.constant({ kind: 'mark' } as const), weight: 1 },
  { arbitrary: fc.constant({ kind: 'reset' } as const), weight: 1 },
  { arbitrary: fc.constant({ kind: 'confirm' } as const), weight: 1 },
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  ops: fc.array(opSeedArb, { maxLength: 24 }),
  actions: fc.array(fc.record({ advance: fc.nat(2), delivery: deliveryArb }), { maxLength: 40 }),
  finalWithTombstones: fc.boolean(),
});

/** One delivery as the checkers see it. */
interface Trace {
  readonly delivery: Delivery;
  readonly before: ReconcilerState;
  /** Right after the reconciler call, before the store's tombstone age-out. */
  readonly applied: ReconcilerState;
  readonly after: ReconcilerState;
  /** The server seq the message describes: the snapshot's `t`, else the server's now. */
  readonly asOf: number;
  readonly serverNow: number;
  /** `maxSeq` of the newest full snapshot applied — the client's set evidence. */
  readonly proven: number;
  readonly steps: readonly HistoryStep[];
}

interface Run {
  readonly state: ReconcilerState;
  readonly server: Server;
}

/**
 * Play a scenario against a fresh client, calling `check` after every delivery. The
 * store's post-message age-out (`expireTombstones(serverNow())`) runs where the store
 * runs it; safety full snapshots are injected on the rhythm the design assumes.
 */
function simulate(scenario: Scenario, check: (trace: Trace) => void): Run {
  const server: Server = { seq: 0, present: new Map(), steps: [] };
  const pendingOps = [...scenario.ops];
  const delivered: HistoryStep[] = [];
  let nextStep = 0;
  let state = createInitialReconcilerState();
  let proven = 0;
  let lastFullDeliveredAt = 0;
  let lastFullT: number | null = null;

  const deliver = (delivery: Delivery): void => {
    const before = state;
    let applied = state;
    let asOf = server.seq;
    let expires = false;
    switch (delivery.kind) {
      case 'frame': {
        // A removal emits nothing — the client sees only the gap it leaves.
        while (nextStep < server.steps.length && at(server.steps, nextStep).frame === null) {
          nextStep += 1;
        }
        if (nextStep < server.steps.length) {
          const change = at(server.steps, nextStep);
          nextStep += 1;
          if (change.frame !== null) {
            delivered.push(change);
            applied = applyDelta(state, [change.frame], isoAt(change.seq));
            expires = true;
          }
        }
        break;
      }
      case 'drop':
        if (nextStep < server.steps.length) nextStep += 1;
        break;
      case 'replay': {
        if (delivered.length > 0) {
          const change = at(delivered, delivery.pick % delivered.length);
          if (change.frame !== null) {
            applied = applyDelta(state, [change.frame], isoAt(change.seq));
            expires = true;
          }
        }
        break;
      }
      case 'full': {
        asOf = Math.max(lastFullDeliveredAt, server.seq - delivery.staleness);
        applied = applySnapshot(state, fullSnapshotAt(server.steps, asOf, delivery.withTombstones));
        proven = Math.max(proven, asOf);
        lastFullDeliveredAt = server.seq;
        lastFullT = asOf;
        expires = true;
        break;
      }
      case 'partial':
        applied = applySnapshot(state, partialSince(server, state.maxSeq));
        expires = true;
        break;
      case 'mark':
        applied = applyStreamFreshness(state, server.seq, isoAt(server.seq));
        break;
      case 'reset':
        applied = applyReset(state);
        break;
      case 'confirm':
        // A 304 is truthful only while the origin's snapshot is still the one the client
        // validated: nothing changed since it was generated.
        if (lastFullT === server.seq) {
          applied = applyConfirmation(state, isoAt(server.seq, 30 * 60_000));
        }
        break;
    }
    state = expires ? expireTombstones(applied, msAt(server.seq)) : applied;
    check({
      delivery,
      before,
      applied,
      after: state,
      asOf,
      serverNow: server.seq,
      proven,
      steps: server.steps,
    });
  };

  for (const action of scenario.actions) {
    for (let i = 0; i < action.advance; i += 1) {
      const seed = pendingOps.shift();
      if (seed !== undefined) step(server, seed);
    }
    if (server.seq - lastFullDeliveredAt >= SAFETY_EVERY) {
      deliver({ kind: 'full', staleness: 0, withTombstones: false });
    }
    deliver(action.delivery);
  }
  return { state, server };
}

// ---------------------------------------------------------------------------------------
// Algebraic properties.
// ---------------------------------------------------------------------------------------

describe('reconciler properties', () => {
  it('never regresses a version, the cursor, the floor or the anchor under any message', () => {
    fc.assert(
      fc.property(stateArb, messageArb, (state, message) => {
        const next = applyMessage(state, message);
        expectNoRegression(state, next);
        for (const [id, stored] of state.events) {
          if (next.events.has(id)) continue;
          // Only a full snapshot removes an active event; only the age-out removes a tombstone.
          expect(message.kind).toBe(stored.mergedInto === null ? 'full' : 'expire');
        }
      }),
    );
  });

  it('applying the same full snapshot twice is idempotent (and a reference-equal no-op)', () => {
    fc.assert(
      fc.property(stateArb, snapshotArb(false), (state, snapshot) => {
        const once = applySnapshot(state, snapshot);
        expect(applySnapshot(once, snapshot)).toBe(once);
      }),
    );
  });

  it('delta batches are order-insensitive under the seq rule', () => {
    fc.assert(
      fc.property(
        stateArb,
        batchWithPermutationArb,
        fc.option(isoArb, { nil: undefined }),
        (state, [batch, permuted], generatedAt) => {
          expect(normalize(applyDelta(state, permuted, generatedAt))).toEqual(
            normalize(applyDelta(state, batch, generatedAt)),
          );
        },
      ),
    );
  });

  it('a delta batch is idempotent: twice equals once, and replaying any prefix is a no-op', () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.array(fireEventArb, { maxLength: 6 }),
        fc.option(isoArb, { nil: undefined }),
        fc.nat(6),
        (state, batch, generatedAt, cut) => {
          const once = applyDelta(state, batch, generatedAt);
          expect(applyDelta(once, batch, generatedAt)).toBe(once);
          expect(applyDelta(once, batch.slice(0, cut), generatedAt)).toBe(once);
        },
      ),
    );
  });

  it('an in-order stream applied one frame at a time equals the same events as one batch', () => {
    fc.assert(
      fc.property(stateWithStreamArb, isoArb, ([state, stream], generatedAt) => {
        const oneAtATime = stream.reduce((s, event) => applyDelta(s, [event], generatedAt), state);
        const batched = applyDelta(state, stream, generatedAt);
        expect(triples(oneAtATime.events)).toEqual(triples(batched.events));
        expect(oneAtATime.maxSeq).toBe(batched.maxSeq);
        // Gap detection is an online check: a batch only sees the gap before its lowest
        // seq, the stream sees every one — so the flags agree exactly when there is at
        // most that one.
        const contiguous = stream.every((event, i) => event.seq === state.maxSeq + i + 1);
        if (contiguous) expect(oneAtATime.needsSnapshot).toBe(batched.needsSnapshot);
      }),
    );
  });

  it('stale deltas never change state', () => {
    fc.assert(
      fc.property(stateWithStaleBatchArb, ([state, staleBatch]) => {
        expect(applyDelta(state, staleBatch)).toBe(state);
      }),
    );
  });

  it('deltas never delete and never regress a stored version', () => {
    fc.assert(
      fc.property(stateArb, fc.array(fireEventArb, { maxLength: 6 }), (state, batch) => {
        const next = applyDelta(state, batch);
        for (const [id, stored] of state.events) {
          const kept = next.events.get(id);
          expect(kept).toBeDefined();
          if (kept !== undefined) expect(kept.seq).toBeGreaterThanOrEqual(stored.seq);
        }
      }),
    );
  });

  it('partial snapshots never remove, never regress, never anchor, lower a flag or note an absence', () => {
    fc.assert(
      fc.property(stateArb, snapshotArb(true), (state, partial) => {
        const next = applySnapshot(state, partial);
        for (const [id, stored] of state.events) {
          const kept = next.events.get(id);
          expect(kept).toBeDefined();
          if (kept !== undefined) expect(kept.seq).toBeGreaterThanOrEqual(stored.seq);
        }
        expect(next.lastSnapshotAt).toBe(state.lastSnapshotAt);
        expect(next.needsSnapshot).toBe(state.needsSnapshot);
        for (const [id, noted] of next.absences) expect(state.absences.get(id)).toBe(noted);
      }),
    );
  });

  it('gap detection fires exactly when a seq is skipped', () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 1, max: 5 }),
        (state, skip, runLength) => {
          const start = state.maxSeq + 1 + skip;
          const batch = Array.from({ length: runLength }, (_, offset) =>
            eventAtSeq(start + offset),
          );
          const next = applyDelta(state, batch);
          expect(next.needsSnapshot).toBe(state.needsSnapshot || skip > 0);
          expect(next.maxSeq).toBe(start + runLength - 1);
          // The floor follows the cursor only across a contiguous step.
          expect(next.settledSeq).toBe(
            state.settledSeq === state.maxSeq && skip === 0 ? next.maxSeq : state.settledSeq,
          );
        },
      ),
    );
  });

  it('a reset only raises the demand: the events stay, and the next full snapshot lands the same', () => {
    fc.assert(
      fc.property(stateArb, snapshotArb(false), (state, snapshot) => {
        const reset = applyReset(state);
        expect(reset.events).toBe(state.events);
        expect(reset.maxSeq).toBe(state.maxSeq);
        expect(reset.lastSnapshotAt).toBe(state.lastSnapshotAt);
        expect(reset.needsSnapshot).toBe(true);
        expect(normalize(applySnapshot(reset, snapshot))).toEqual(
          normalize(applySnapshot(state, snapshot)),
        );
      }),
    );
  });

  it('applying a delta before or after the full snapshot it postdates lands the same events (no buffering needed)', () => {
    fc.assert(
      fc.property(bufferingCaseArb, ({ state, snapshot, delta, generatedAt }) => {
        const applyNow = applySnapshot(applyDelta(state, delta, generatedAt), snapshot);
        const buffered = applyDelta(applySnapshot(state, snapshot), delta, generatedAt);
        expect(triples(applyNow.events)).toEqual(triples(buffered.events));
        expect(applyNow.maxSeq).toBe(buffered.maxSeq);
      }),
    );
  });

  // -------------------------------------------------------------------------------------
  // Against the server model.
  // -------------------------------------------------------------------------------------

  it('never regresses a version, the cursor or the floor, and never runs ahead of the server', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        simulate(scenario, ({ before, after, serverNow }) => {
          expectNoRegression(before, after);
          expect(after.maxSeq).toBeLessThanOrEqual(serverNow);
        });
      }),
    );
  });

  it('holds no zombies: every active event at or below the set evidence is active on the server there', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        simulate(scenario, ({ after, proven, steps }) => {
          const active = activeAt(steps, proven);
          for (const [id, seq] of activePairs(after.events)) {
            if (seq > proven) continue;
            expect(active.get(id)?.seq).toBe(seq);
          }
        });
      }),
    );
  });

  it('never flicker-deletes: an active event is dropped only by a full snapshot, and never in a version the server still holds', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        simulate(scenario, ({ delivery, before, after, asOf, serverNow, steps }) => {
          for (const [id, seq] of activePairs(before.events)) {
            if (after.events.has(id)) continue;
            expect(delivery.kind).toBe('full');
            expect(activeAt(steps, asOf).has(id)).toBe(false);
            expect(activeAt(steps, serverNow).get(id)?.seq).not.toBe(seq);
          }
        });
      }),
    );
  });

  it('treats every replayed frame as a reference-equal no-op', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        simulate(scenario, ({ delivery, before, applied }) => {
          if (delivery.kind === 'replay') expect(applied).toBe(before);
        });
      }),
    );
  });

  it('converges the active set exactly on the next fresh full snapshot (S15)', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { state, server } = simulate(scenario, () => undefined);
        const fresh = fullSnapshotAt(server.steps, server.seq, scenario.finalWithTombstones);
        const settled = applySnapshot(state, fresh);

        expect(activePairs(settled.events)).toEqual(activePairs(server.present));
        expect(settled.maxSeq).toBe(server.seq);
        expect(settled.settledSeq).toBe(server.seq);
        expect(settled.needsSnapshot).toBe(false);
        expect(Date.parse(settled.lastSnapshotAt ?? '')).toBeGreaterThanOrEqual(
          Date.parse(fresh.generatedAt),
        );
        expect(applySnapshot(settled, fresh)).toBe(settled);
      }),
    );
  });

  it('ages tombstones out on the server clock: none older than the TTL survives an age-out', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        simulate(scenario, ({ delivery, after, serverNow }) => {
          if (
            delivery.kind !== 'frame' &&
            delivery.kind !== 'full' &&
            delivery.kind !== 'partial'
          ) {
            return;
          }
          for (const [, mergedAtMs] of after.tombstonedAt) {
            expect(mergedAtMs + TOMBSTONE_TTL_MS).toBeGreaterThan(msAt(serverNow));
          }
        });
      }),
    );
  });
});
