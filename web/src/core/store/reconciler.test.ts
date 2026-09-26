import { describe, expect, it } from 'vitest';

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
  mergeSourceRows,
} from './reconciler.js';

/** `id` is the store key; tests use short opaque ids, the reconciler never parses them. */
function makeEvent(id: string, seq: number, overrides: Partial<FireEvent> = {}): FireEvent {
  return {
    id,
    seq,
    status: 'active',
    scoreBucket: 'confirmed',
    mergedInto: null,
    lon: 25.9,
    lat: 41.93,
    firstObservedAt: '2026-08-07T11:14:00Z',
    lastObservedAt: '2026-08-09T09:47:00Z',
    detectionCount: 1,
    placeNameBg: 'Харманли',
    placeNameEn: 'Harmanli',
    areaHa: null,
    nextPassWindow: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const events = overrides.events ?? [];
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-09T09:58:00Z',
    maxSeq: Math.max(0, ...events.map((event) => event.seq)),
    partial: false,
    events,
    sources: [],
    ...overrides,
  };
}

/** A settled state (no gap outstanding): the floor sits at `maxSeq` unless overridden. */
function stateWith(
  events: readonly FireEvent[],
  overrides: Partial<ReconcilerState> = {},
): ReconcilerState {
  const maxSeq = overrides.maxSeq ?? Math.max(0, ...events.map((event) => event.seq));
  return {
    events: new Map(events.map((event) => [event.id, event])),
    maxSeq,
    settledSeq: maxSeq,
    lastSnapshotAt: '2026-08-09T09:00:00Z',
    needsSnapshot: false,
    absences: new Map(),
    tombstonedAt: new Map(),
    sources: [],
    ...overrides,
  };
}

function eventOf(state: ReconcilerState, id: string): FireEvent {
  const event = state.events.get(id);
  if (event === undefined) throw new Error(`no event with id ${id}`);
  return event;
}

const MERGED_AT = '2026-08-09T09:30:00Z';
const MERGED_AT_MS = Date.parse(MERGED_AT);

describe('createInitialReconcilerState', () => {
  it('starts empty, at seq 0, with no snapshot anchor, no demand and no bookkeeping', () => {
    const state = createInitialReconcilerState();
    expect(state.events.size).toBe(0);
    expect(state.maxSeq).toBe(0);
    expect(state.settledSeq).toBe(0);
    expect(state.lastSnapshotAt).toBeNull();
    expect(state.needsSnapshot).toBe(false);
    expect(state.absences.size).toBe(0);
    expect(state.tombstonedAt.size).toBe(0);
  });
});

describe('applySnapshot — full (set authority)', () => {
  it('replaces the event set when its maxSeq postdates every absent stored event', () => {
    const state = stateWith([makeEvent('a', 1), makeEvent('b', 2)]);
    const snapshot = makeSnapshot({ events: [makeEvent('b', 3), makeEvent('c', 4)] });

    const next = applySnapshot(state, snapshot);

    expect([...next.events.keys()].sort()).toEqual(['b', 'c']);
    expect(eventOf(next, 'b').seq).toBe(3);
  });

  it('keeps a fresher stored version — a cached snapshot never regresses an event', () => {
    const fresher = makeEvent('a', 9, { detectionCount: 14 });
    const state = stateWith([fresher], { maxSeq: 9 });
    const snapshot = makeSnapshot({ events: [makeEvent('a', 5)], maxSeq: 10 });

    const next = applySnapshot(state, snapshot);

    expect(eventOf(next, 'a')).toBe(fresher);
  });

  it('keeps the stored object on an equal seq — same version, stabler reference', () => {
    const stored = makeEvent('a', 9);
    const state = stateWith([stored]);
    const snapshot = makeSnapshot({ events: [makeEvent('a', 9, { detectionCount: 3 })] });

    expect(eventOf(applySnapshot(state, snapshot), 'a')).toBe(stored);
  });

  it('keeps tombstones that the snapshot carries — they are events, not removals', () => {
    const tombstone = makeEvent('loser', 6, { status: 'archived', mergedInto: 'winner' });
    const snapshot = makeSnapshot({ events: [makeEvent('winner', 7), tombstone] });

    const next = applySnapshot(createInitialReconcilerState(), snapshot);

    expect(eventOf(next, 'loser')).toBe(tombstone);
  });

  it('anchors lastSnapshotAt, clears needsSnapshot, and takes max(maxSeq)', () => {
    const state = stateWith([makeEvent('a', 12)], { maxSeq: 12, needsSnapshot: true });
    const snapshot = makeSnapshot({
      events: [makeEvent('a', 12)],
      maxSeq: 8,
      generatedAt: '2026-08-09T10:15:00Z',
    });

    const next = applySnapshot(state, snapshot);

    expect(next.lastSnapshotAt).toBe('2026-08-09T10:15:00Z');
    expect(next.needsSnapshot).toBe(false);
    expect(next.maxSeq).toBe(12);
  });

  it('never regresses lastSnapshotAt on an older full snapshot', () => {
    const state = stateWith([makeEvent('a', 12)], { lastSnapshotAt: '2026-08-09T10:00:00Z' });
    const older = makeSnapshot({
      events: [makeEvent('a', 12)],
      generatedAt: '2026-08-09T09:59:59.999Z',
    });

    expect(applySnapshot(state, older).lastSnapshotAt).toBe('2026-08-09T10:00:00Z');
  });

  it('compares lastSnapshotAt as instants, not strings', () => {
    const state = stateWith([makeEvent('a', 12)], { lastSnapshotAt: '2026-08-09T10:00:00Z' });
    const newer = makeSnapshot({
      events: [makeEvent('a', 12)],
      generatedAt: '2026-08-09T10:00:00.001Z',
    });

    expect(applySnapshot(state, newer).lastSnapshotAt).toBe('2026-08-09T10:00:00.001Z');
  });

  it('applied twice is a reference-equal no-op the second time', () => {
    const snapshot = makeSnapshot({ events: [makeEvent('a', 1), makeEvent('b', 2)] });
    const once = applySnapshot(createInitialReconcilerState(), snapshot);
    const twice = applySnapshot(once, snapshot);

    expect(twice).toBe(once);
  });

  describe('conditional removal (two consecutive authoritative absences)', () => {
    const stored = makeEvent('x', 10);

    it('removes an absent event only when the snapshot postdates it', () => {
      const state = stateWith([stored, makeEvent('y', 4)]);

      expect(applySnapshot(state, makeSnapshot({ events: [], maxSeq: 10 })).events.has('x')).toBe(
        true,
      );
      expect(applySnapshot(state, makeSnapshot({ events: [], maxSeq: 11 })).events.has('x')).toBe(
        false,
      );
    });

    it('notes a first absence it cannot prove instead of removing', () => {
      const state = stateWith([stored]);

      const next = applySnapshot(state, makeSnapshot({ events: [], maxSeq: 8 }));

      expect(next.events.get('x')).toBe(stored);
      expect(next.absences.get('x')).toBe(8);
    });

    it('removes on a second absence from a snapshot with a higher maxSeq', () => {
      const first = applySnapshot(stateWith([stored]), makeSnapshot({ events: [], maxSeq: 8 }));

      const second = applySnapshot(first, makeSnapshot({ events: [], maxSeq: 9 }));

      expect(second.events.has('x')).toBe(false);
      expect(second.absences.has('x')).toBe(false);
    });

    it('re-applying the identical snapshot object is a reference-equal no-op, not a second absence', () => {
      const snapshot = makeSnapshot({ events: [], maxSeq: 8 });
      const first = applySnapshot(stateWith([stored]), snapshot);

      expect(applySnapshot(first, snapshot)).toBe(first);
      expect(first.events.get('x')).toBe(stored);
    });

    it('does not lower a noted absence when an even older snapshot omits the event', () => {
      const first = applySnapshot(stateWith([stored]), makeSnapshot({ events: [], maxSeq: 8 }));

      const older = applySnapshot(first, makeSnapshot({ events: [], maxSeq: 6 }));

      expect(older.absences.get('x')).toBe(8);
      expect(older.events.get('x')).toBe(stored);
    });

    it('clears the note when a later snapshot carries the event — even as a stale copy', () => {
      const first = applySnapshot(stateWith([stored]), makeSnapshot({ events: [], maxSeq: 8 }));

      const present = applySnapshot(
        first,
        makeSnapshot({ events: [makeEvent('x', 7)], maxSeq: 9 }),
      );

      expect(present.absences.has('x')).toBe(false);
      expect(present.events.get('x')).toBe(stored);
      // The run of absences starts over.
      const absentAgain = applySnapshot(present, makeSnapshot({ events: [], maxSeq: 9 }));
      expect(absentAgain.events.get('x')).toBe(stored);
      expect(absentAgain.absences.get('x')).toBe(9);
    });

    it('clears the note when a delta applies a newer copy — a just-updated event is not gone', () => {
      const first = applySnapshot(stateWith([stored]), makeSnapshot({ events: [], maxSeq: 8 }));

      const updated = applyDelta(first, [makeEvent('x', 11)]);

      expect(updated.absences.has('x')).toBe(false);
    });

    it('never removes a tombstone for being absent', () => {
      const tombstone = makeEvent('t', 3, { mergedInto: 'w' });
      const state = stateWith([tombstone, makeEvent('w', 4)]);

      const next = applySnapshot(state, makeSnapshot({ events: [makeEvent('w', 4)], maxSeq: 20 }));

      expect(next.events.get('t')).toBe(tombstone);
      expect(next.absences.has('t')).toBe(false);
      expect(
        applySnapshot(next, makeSnapshot({ events: [makeEvent('w', 4)], maxSeq: 21 })).events.get(
          't',
        ),
      ).toBe(tombstone);
    });
  });

  it('dates a tombstone it carries with its generatedAt', () => {
    const tombstone = makeEvent('t', 3, { mergedInto: 'w' });
    const snapshot = makeSnapshot({ events: [tombstone], generatedAt: MERGED_AT });

    const next = applySnapshot(createInitialReconcilerState(), snapshot);

    expect(next.tombstonedAt.get('t')).toBe(MERGED_AT_MS);
  });

  it('re-settles the stale-create floor after a gap so the snapshot can fill it', () => {
    // Client at 5 sees frame 8: a gap. The snapshot that follows carries the event created
    // at 6 (which the client never saw); the floor must not block it.
    const gapped = applyDelta(stateWith([makeEvent('a', 5)]), [makeEvent('b', 8)]);
    expect(gapped.maxSeq).toBe(8);
    expect(gapped.settledSeq).toBe(5);

    const snapshot = makeSnapshot({
      events: [makeEvent('a', 5), makeEvent('c', 6), makeEvent('b', 8)],
      maxSeq: 8,
    });
    const next = applySnapshot(gapped, snapshot);

    expect(next.events.has('c')).toBe(true);
    expect(next.settledSeq).toBe(8);
    expect(next.needsSnapshot).toBe(false);
  });
});

describe('applySnapshot — partial (upsert-only batch)', () => {
  it('upserts without removing anything', () => {
    const state = stateWith([makeEvent('a', 1), makeEvent('b', 2)]);
    const snapshot = makeSnapshot({
      partial: true,
      events: [makeEvent('b', 3), makeEvent('c', 4)],
    });

    const next = applySnapshot(state, snapshot);

    expect([...next.events.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(eventOf(next, 'b').seq).toBe(3);
  });

  it('seq-guards each event: a stale copy in the batch is a no-op', () => {
    const fresher = makeEvent('a', 9);
    const state = stateWith([fresher]);
    const snapshot = makeSnapshot({ partial: true, events: [makeEvent('a', 4)], maxSeq: 9 });

    expect(eventOf(applySnapshot(state, snapshot), 'a')).toBe(fresher);
  });

  it('never moves lastSnapshotAt, never lowers needsSnapshot, never touches absences', () => {
    const noted = applyReset(
      applySnapshot(
        stateWith([makeEvent('a', 10)]),
        makeSnapshot({ events: [], maxSeq: 8, generatedAt: '2026-08-09T08:00:00Z' }),
      ),
    );
    expect(noted.absences.get('a')).toBe(8);
    const snapshot = makeSnapshot({
      partial: true,
      events: [makeEvent('b', 11)],
      generatedAt: '2026-08-09T10:30:00Z',
    });

    const next = applySnapshot(noted, snapshot);

    expect(next.lastSnapshotAt).toBe(noted.lastSnapshotAt);
    expect(next.needsSnapshot).toBe(true);
    expect(next.absences).toBe(noted.absences);
  });

  it('advances maxSeq from the batch metadata', () => {
    const state = stateWith([makeEvent('a', 3)]);
    const snapshot = makeSnapshot({ partial: true, events: [], maxSeq: 30 });

    expect(applySnapshot(state, snapshot).maxSeq).toBe(30);
  });

  it('with nothing new is a reference-equal no-op', () => {
    const state = stateWith([makeEvent('a', 3)]);
    const snapshot = makeSnapshot({ partial: true, events: [makeEvent('a', 3)], maxSeq: 3 });

    expect(applySnapshot(state, snapshot)).toBe(state);
  });

  it('settles the floor when no gap is outstanding, and leaves it while one is', () => {
    const settled = applySnapshot(
      stateWith([makeEvent('a', 3)]),
      makeSnapshot({ partial: true, events: [makeEvent('b', 5)], maxSeq: 6 }),
    );
    expect(settled.settledSeq).toBe(6);

    const gapped = applyDelta(stateWith([makeEvent('a', 3)]), [makeEvent('b', 7)]);
    const stillGapped = applySnapshot(
      gapped,
      makeSnapshot({ partial: true, events: [makeEvent('c', 8)], maxSeq: 8 }),
    );
    expect(stillGapped.maxSeq).toBe(8);
    expect(stillGapped.settledSeq).toBe(3);
  });
});

describe('the stale-create guard', () => {
  const state = stateWith([makeEvent('a', 8)], { maxSeq: 10 });

  it('a delta refuses an unknown id at or below the floor', () => {
    expect(applyDelta(state, [makeEvent('z', 10)])).toBe(state);
    expect(applyDelta(state, [makeEvent('z', 3)])).toBe(state);
    expect(applyDelta(state, [makeEvent('z', 11)]).events.has('z')).toBe(true);
  });

  it('a partial snapshot refuses an unknown id at or below the floor', () => {
    const stale = makeSnapshot({ partial: true, events: [makeEvent('z', 10)], maxSeq: 10 });
    expect(applySnapshot(state, stale)).toBe(state);

    const fresh = makeSnapshot({ partial: true, events: [makeEvent('z', 11)], maxSeq: 11 });
    expect(applySnapshot(state, fresh).events.has('z')).toBe(true);
  });

  it('a full snapshot refuses an unknown id at or below the floor — a cached copy cannot resurrect', () => {
    // The stored `a` is kept: the snapshot's maxSeq does not postdate it.
    const stale = makeSnapshot({ events: [makeEvent('a', 8), makeEvent('z', 9)], maxSeq: 9 });
    const next = applySnapshot(state, stale);
    expect(next.events.has('z')).toBe(false);
    expect(next.events.has('a')).toBe(true);

    const fresh = makeSnapshot({ events: [makeEvent('a', 8), makeEvent('z', 11)], maxSeq: 11 });
    expect(applySnapshot(state, fresh).events.has('z')).toBe(true);
  });

  it('a cold client (maxSeq 0) creates everything', () => {
    const snapshot = makeSnapshot({ events: [makeEvent('a', 1), makeEvent('b', 40)] });
    expect(applySnapshot(createInitialReconcilerState(), snapshot).events.size).toBe(2);
    expect(applyDelta(createInitialReconcilerState(), [makeEvent('a', 1)]).events.size).toBe(1);
  });

  it('still updates a known id below maxSeq — the floor only guards creates', () => {
    const catchUp = makeEvent('a', 9);
    expect(eventOf(applyDelta(state, [catchUp]), 'a')).toBe(catchUp);
  });

  it('treats un-tombstoning as a create: a late un-merge at or below the floor is refused', () => {
    // create t (1), merge t (2), un-merge t (3), remove t (4): the full snapshot at 4 omits
    // t, which stays as a tombstone; the un-merge frame then lands late and must not turn
    // it back into an active event the server no longer has.
    const tombstone = makeEvent('t', 2, { status: 'archived', mergedInto: 'w' });
    const withTombstone = applyDelta(stateWith([makeEvent('w', 1)]), [tombstone]);
    const proven = applySnapshot(
      withTombstone,
      makeSnapshot({ events: [makeEvent('w', 1)], maxSeq: 4 }),
    );
    expect(proven.events.get('t')).toBe(tombstone);

    expect(applyDelta(proven, [makeEvent('t', 3)])).toBe(proven);
    // A genuinely newer un-merge, above the floor, applies as any update does.
    const revived = makeEvent('t', 5);
    expect(eventOf(applyDelta(proven, [revived]), 't')).toBe(revived);
  });

  it('classifies un-tombstoning against the pre-message state, so a batch is order-insensitive', () => {
    // Fast-check counterexample (seed 1688227129): stored a@1 active, floor 3, and one
    // batch carrying both a@2 (tombstone) and a@3 (active). Classifying against the draft
    // let a@2, applied first, turn a@3 into an under-floor "create" — so the batch's
    // outcome depended on array order. Against the state, neither copy creates: a@3 wins
    // either way.
    const stored = makeEvent('a', 1);
    const state = stateWith([stored], { maxSeq: 3 });
    const tombstone = makeEvent('a', 2, { status: 'archived', mergedInto: 'w' });
    const active = makeEvent('a', 3);

    expect(eventOf(applyDelta(state, [active, tombstone]), 'a')).toBe(active);
    expect(eventOf(applyDelta(state, [tombstone, active]), 'a')).toBe(active);
  });
});

describe('applyDelta', () => {
  it('inserts an unknown event', () => {
    const state = stateWith([makeEvent('a', 1)]);
    const incoming = makeEvent('b', 2);

    const next = applyDelta(state, [incoming]);

    expect(eventOf(next, 'b')).toBe(incoming);
    expect(next.events.size).toBe(2);
  });

  it('upserts a strictly newer version and keeps everything else', () => {
    const state = stateWith([makeEvent('a', 1), makeEvent('b', 2)]);
    const newer = makeEvent('a', 3, { detectionCount: 7 });

    const next = applyDelta(state, [newer]);

    expect(eventOf(next, 'a')).toBe(newer);
    expect(next.events.size).toBe(2);
  });

  it('treats stale and equal-seq copies as reference-equal no-ops', () => {
    const state = stateWith([makeEvent('a', 5)]);

    expect(applyDelta(state, [makeEvent('a', 4)])).toBe(state);
    expect(applyDelta(state, [makeEvent('a', 5, { detectionCount: 99 })])).toBe(state);
  });

  it('never deletes — a delta cannot shrink the set', () => {
    const state = stateWith([makeEvent('a', 1), makeEvent('b', 2)]);

    const next = applyDelta(state, [makeEvent('c', 3)]);

    expect(next.events.size).toBe(3);
    expect(next.events.has('a')).toBe(true);
    expect(next.events.has('b')).toBe(true);
  });

  it('upserts an event whose seq is behind maxSeq but ahead of the stored copy', () => {
    const state = stateWith([makeEvent('a', 2), makeEvent('b', 10)], { maxSeq: 10 });
    const catchUp = makeEvent('a', 4);

    const next = applyDelta(state, [catchUp]);

    expect(eventOf(next, 'a')).toBe(catchUp);
    expect(next.needsSnapshot).toBe(false);
  });

  it('advances maxSeq to the highest incoming seq', () => {
    const state = stateWith([makeEvent('a', 5)], { maxSeq: 5 });

    expect(applyDelta(state, [makeEvent('a', 6), makeEvent('b', 7)]).maxSeq).toBe(7);
  });

  it('resolves a duplicate id within one batch to its highest seq, whatever the order', () => {
    const state = stateWith([makeEvent('a', 1)]);
    const highest = makeEvent('a', 3);

    expect(eventOf(applyDelta(state, [highest, makeEvent('a', 2)]), 'a')).toBe(highest);
    expect(eventOf(applyDelta(state, [makeEvent('a', 2), highest]), 'a')).toBe(highest);
  });

  describe('tombstone instants', () => {
    const merged = makeEvent('t', 6, { status: 'archived', mergedInto: 'w' });

    it('dates an applied tombstone with the frame instant', () => {
      const next = applyDelta(stateWith([makeEvent('t', 5)]), [merged], MERGED_AT);

      expect(next.tombstonedAt.get('t')).toBe(MERGED_AT_MS);
    });

    it('leaves an applied tombstone undated when the frame carries no instant', () => {
      const next = applyDelta(stateWith([makeEvent('t', 5)]), [merged]);

      expect(next.events.get('t')).toBe(merged);
      expect(next.tombstonedAt.has('t')).toBe(false);
    });

    it('does not date a tombstone it did not apply', () => {
      const state = stateWith([makeEvent('t', 9)]);

      expect(applyDelta(state, [merged], MERGED_AT)).toBe(state);
    });

    it('undates an event that is un-merged again', () => {
      const dated = applyDelta(stateWith([makeEvent('t', 5)]), [merged], MERGED_AT);

      const revived = applyDelta(dated, [makeEvent('t', 7)], '2026-08-09T09:40:00Z');

      expect(revived.tombstonedAt.has('t')).toBe(false);
    });

    it('re-dates a newer tombstone version, and undates it when the newer frame has no instant', () => {
      const dated = applyDelta(stateWith([makeEvent('t', 5)]), [merged], MERGED_AT);
      const newer = makeEvent('t', 8, { status: 'archived', mergedInto: 'x' });

      expect(applyDelta(dated, [newer], '2026-08-09T09:40:00Z').tombstonedAt.get('t')).toBe(
        Date.parse('2026-08-09T09:40:00Z'),
      );
      // The old date belonged to the version it dated; carrying it over would age a
      // merge the client knows nothing about by an instant that is not its own.
      expect(applyDelta(dated, [newer]).tombstonedAt.has('t')).toBe(false);
    });
  });

  describe('gap detection', () => {
    it('does not fire on the contiguous next seq', () => {
      const state = stateWith([makeEvent('a', 5)], { maxSeq: 5 });

      expect(applyDelta(state, [makeEvent('a', 6)]).needsSnapshot).toBe(false);
    });

    it('fires when the lowest new seq skips past maxSeq + 1', () => {
      const state = stateWith([makeEvent('a', 5)], { maxSeq: 5 });

      const next = applyDelta(state, [makeEvent('a', 7)]);

      expect(next.needsSnapshot).toBe(true);
      expect(eventOf(next, 'a').seq).toBe(7);
    });

    it('moves maxSeq but not the floor across a gap', () => {
      const state = stateWith([makeEvent('a', 5)], { maxSeq: 5 });

      const next = applyDelta(state, [makeEvent('a', 7)]);

      expect(next.maxSeq).toBe(7);
      expect(next.settledSeq).toBe(5);
      // Contiguous frames after that keep the floor where it is: the hole is still open.
      const later = applyDelta(next, [makeEvent('b', 8)]);
      expect(later.maxSeq).toBe(8);
      expect(later.settledSeq).toBe(5);
    });

    it('does not fire on a contiguous batch, whatever its order', () => {
      const state = stateWith([makeEvent('a', 5)], { maxSeq: 5 });
      const batch = [makeEvent('b', 8), makeEvent('a', 6), makeEvent('c', 7)];

      expect(applyDelta(state, batch).needsSnapshot).toBe(false);
    });

    it('keys off min(newSeqs) only — an intra-batch hole is outside the documented assumption', () => {
      // The assumption (documented on applyDelta): deltas carry all changes, so a batch
      // with an internal hole cannot occur on the wire; the pinned rule therefore only
      // inspects the lowest new seq. Revisit with the real delta contract (Track E).
      const state = stateWith([makeEvent('a', 5)], { maxSeq: 5 });

      expect(applyDelta(state, [makeEvent('a', 6), makeEvent('b', 9)]).needsSnapshot).toBe(false);
    });

    it('ignores stale seqs when looking for gaps', () => {
      const state = stateWith([makeEvent('a', 2), makeEvent('b', 10)], { maxSeq: 10 });

      expect(applyDelta(state, [makeEvent('a', 4)]).needsSnapshot).toBe(false);
    });

    it('keeps applying deltas normally while needsSnapshot is up', () => {
      const state = stateWith([makeEvent('a', 5)], { maxSeq: 5, needsSnapshot: true });
      const incoming = makeEvent('b', 6);

      const next = applyDelta(state, [incoming]);

      expect(eventOf(next, 'b')).toBe(incoming);
      expect(next.needsSnapshot).toBe(true);
    });

    it('is lowered again only by a full snapshot', () => {
      const state = stateWith([makeEvent('a', 5)], { maxSeq: 5 });
      const gapped = applyDelta(state, [makeEvent('b', 9)]);
      expect(gapped.needsSnapshot).toBe(true);

      const partial = makeSnapshot({ partial: true, events: [makeEvent('c', 10)], maxSeq: 10 });
      expect(applySnapshot(gapped, partial).needsSnapshot).toBe(true);

      const full = makeSnapshot({ events: [makeEvent('b', 9)], maxSeq: 10 });
      expect(applySnapshot(gapped, full).needsSnapshot).toBe(false);
    });
  });
});

describe('applyReset', () => {
  it('keeps the events and the cursor — only the snapshot demand is raised', () => {
    const state = stateWith([makeEvent('a', 1), makeEvent('b', 2)]);

    const next = applyReset(state);

    expect(next.events).toBe(state.events);
    expect(next.maxSeq).toBe(2);
    expect(next.lastSnapshotAt).toBe(state.lastSnapshotAt);
    expect(next.needsSnapshot).toBe(true);
  });

  it('is a reference-equal no-op when the demand is already up', () => {
    const once = applyReset(stateWith([makeEvent('a', 1)]));

    expect(applyReset(once)).toBe(once);
  });

  it('then a full snapshot reconciles the set, removals included', () => {
    const state = stateWith([makeEvent('a', 1), makeEvent('b', 2)]);
    const snapshot = makeSnapshot({ events: [makeEvent('c', 3)], maxSeq: 3 });

    const next = applySnapshot(applyReset(state), snapshot);

    expect([...next.events.keys()]).toEqual(['c']);
    expect(next.maxSeq).toBe(3);
    expect(next.lastSnapshotAt).toBe(snapshot.generatedAt);
    expect(next.needsSnapshot).toBe(false);
  });
});

describe('applyStreamFreshness', () => {
  it('raises needsSnapshot without moving maxSeq when the mark is ahead', () => {
    const state = stateWith([makeEvent('a', 5)]);

    const next = applyStreamFreshness(state, 7, '2026-08-09T10:00:00Z');

    expect(next.needsSnapshot).toBe(true);
    expect(next.maxSeq).toBe(5);
    expect(next.settledSeq).toBe(5);
    expect(next.lastSnapshotAt).toBe(state.lastSnapshotAt);
    expect(next.events).toBe(state.events);
  });

  it('confirms the anchor when the client is caught up', () => {
    const state = stateWith([makeEvent('a', 5)]);

    expect(applyStreamFreshness(state, 5, '2026-08-09T10:00:00Z').lastSnapshotAt).toBe(
      '2026-08-09T10:00:00Z',
    );
    expect(applyStreamFreshness(state, 4, '2026-08-09T10:00:00Z').lastSnapshotAt).toBe(
      '2026-08-09T10:00:00Z',
    );
  });

  it('is a reference-equal no-op when ahead and already demanding, or caught up and not newer', () => {
    const demanding = stateWith([makeEvent('a', 5)], { needsSnapshot: true });
    expect(applyStreamFreshness(demanding, 9, '2026-08-09T10:00:00Z')).toBe(demanding);

    const state = stateWith([makeEvent('a', 5)]);
    expect(applyStreamFreshness(state, 5, '2026-08-09T08:00:00Z')).toBe(state);
  });
});

describe('applyConfirmation', () => {
  it('advances the anchor to a strictly newer instant', () => {
    const state = stateWith([makeEvent('a', 5)]);

    expect(applyConfirmation(state, '2026-08-09T09:00:00.001Z').lastSnapshotAt).toBe(
      '2026-08-09T09:00:00.001Z',
    );
  });

  it('never regresses, and treats an equal instant as a no-op', () => {
    const state = stateWith([makeEvent('a', 5)]);

    expect(applyConfirmation(state, '2026-08-09T08:59:59Z')).toBe(state);
    expect(applyConfirmation(state, '2026-08-09T09:00:00.000Z')).toBe(state);
  });

  it('ignores a confirmation when there is no anchor to confirm', () => {
    const state = stateWith([makeEvent('a', 5)], { lastSnapshotAt: null });

    expect(applyConfirmation(state, '2026-08-09T10:00:00Z')).toBe(state);
  });

  it('ignores a confirmation while a snapshot is owed', () => {
    const state = stateWith([makeEvent('a', 5)], { needsSnapshot: true });

    expect(applyConfirmation(state, '2026-08-09T10:00:00Z')).toBe(state);
  });

  it('ignores an unparseable instant', () => {
    const state = stateWith([makeEvent('a', 5)]);

    expect(applyConfirmation(state, 'not-a-date')).toBe(state);
  });
});

describe('expireTombstones', () => {
  const tombstone = makeEvent('t', 6, { status: 'archived', mergedInto: 'w' });
  const dated = stateWith([tombstone, makeEvent('w', 7)], {
    tombstonedAt: new Map([['t', MERGED_AT_MS]]),
    absences: new Map([['t', 3]]),
  });

  it('removes a tombstone at exactly the TTL, with its bookkeeping', () => {
    const next = expireTombstones(dated, MERGED_AT_MS + TOMBSTONE_TTL_MS);

    expect(next.events.has('t')).toBe(false);
    expect(next.events.has('w')).toBe(true);
    expect(next.tombstonedAt.has('t')).toBe(false);
    expect(next.absences.has('t')).toBe(false);
  });

  it('keeps it one millisecond before the TTL — as a reference-equal no-op', () => {
    expect(expireTombstones(dated, MERGED_AT_MS + TOMBSTONE_TTL_MS - 1)).toBe(dated);
  });

  it('never expires a tombstone without an instant', () => {
    const undated = stateWith([tombstone]);

    expect(expireTombstones(undated, Number.MAX_SAFE_INTEGER)).toBe(undated);
  });

  it('never touches an active event, whatever the instant says', () => {
    // Defensive: applying an active copy clears the instant, so this cannot arise; the
    // event must survive even if it somehow did.
    const active = makeEvent('t', 8);
    const state = stateWith([active], { tombstonedAt: new Map([['t', MERGED_AT_MS]]) });

    const next = expireTombstones(state, MERGED_AT_MS + TOMBSTONE_TTL_MS);

    expect(next.events.get('t')).toBe(active);
    expect(next.tombstonedAt.has('t')).toBe(false);
  });

  it('exposes the TTL as 24 hours', () => {
    expect(TOMBSTONE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('per-source recency (F4)', () => {
  const SNPP = 'firms:viirs:snpp';
  const MODIS = 'firms:modis';

  it('starts with no sources', () => {
    expect(createInitialReconcilerState().sources).toEqual([]);
  });

  it('takes the sources a full snapshot carries', () => {
    const next = applySnapshot(
      stateWith([]),
      makeSnapshot({
        sources: [
          { sourceId: SNPP, lastObservedAt: '2026-08-09T09:40:00Z' },
          { sourceId: MODIS, lastObservedAt: null },
        ],
      }),
    );
    expect(next.sources).toEqual([
      { sourceId: SNPP, lastObservedAt: '2026-08-09T09:40:00Z' },
      { sourceId: MODIS, lastObservedAt: null },
    ]);
  });

  it('takes the sources a partial snapshot carries too', () => {
    const next = applySnapshot(
      stateWith([]),
      makeSnapshot({
        partial: true,
        sources: [{ sourceId: SNPP, lastObservedAt: '2026-08-09T09:40:00Z' }],
      }),
    );
    expect(next.sources).toEqual([{ sourceId: SNPP, lastObservedAt: '2026-08-09T09:40:00Z' }]);
  });

  it('never moves a source backwards, to null, or onto garbage — a cached snapshot can be older', () => {
    const known = [{ sourceId: SNPP, lastObservedAt: '2026-08-09T09:40:00Z' }];
    const state = stateWith([], { sources: known });
    for (const lastObservedAt of ['2026-08-09T09:00:00Z', '2026-08-09T09:40:00Z', null, 'soon']) {
      const next = applySnapshot(
        state,
        makeSnapshot({ sources: [{ sourceId: SNPP, lastObservedAt }] }),
      );
      expect(next.sources).toBe(known);
    }
  });

  it('keeps a source the carrier omits, with its last known instant', () => {
    const state = stateWith([], {
      sources: [{ sourceId: SNPP, lastObservedAt: '2026-08-09T09:40:00Z' }],
    });
    const next = applySnapshot(
      state,
      makeSnapshot({ sources: [{ sourceId: MODIS, lastObservedAt: '2026-08-09T09:50:00Z' }] }),
    );
    expect(next.sources).toEqual([
      { sourceId: SNPP, lastObservedAt: '2026-08-09T09:40:00Z' },
      { sourceId: MODIS, lastObservedAt: '2026-08-09T09:50:00Z' },
    ]);
  });

  it('re-applying the same snapshot is a no-op, sources included', () => {
    const snapshot = makeSnapshot({
      events: [makeEvent('a', 3)],
      sources: [{ sourceId: SNPP, lastObservedAt: '2026-08-09T09:40:00Z' }],
    });
    const once = applySnapshot(createInitialReconcilerState(), snapshot);
    expect(applySnapshot(once, snapshot)).toBe(once);
  });

  it('a newer instant alone is a change', () => {
    const state = stateWith([], {
      sources: [{ sourceId: SNPP, lastObservedAt: '2026-08-09T09:40:00Z' }],
    });
    const next = applySnapshot(
      state,
      makeSnapshot({
        maxSeq: state.maxSeq,
        generatedAt: '2026-08-09T09:00:00Z',
        sources: [{ sourceId: SNPP, lastObservedAt: '2026-08-09T09:55:00Z' }],
      }),
    );
    expect(next).not.toBe(state);
    expect(next.sources).toEqual([{ sourceId: SNPP, lastObservedAt: '2026-08-09T09:55:00Z' }]);
  });

  it('stream freshness merges sources on a confirmation and on a snapshot demand alike', () => {
    const rows = [{ sourceId: SNPP, lastObservedAt: '2026-08-09T09:55:00Z' }];
    const state = stateWith([makeEvent('a', 4)]);

    const confirmed = applyStreamFreshness(state, 4, '2026-08-09T10:00:00Z', rows);
    expect(confirmed.lastSnapshotAt).toBe('2026-08-09T10:00:00Z');
    expect(confirmed.sources).toEqual(rows);

    const demanded = applyStreamFreshness(state, 9, '2026-08-09T10:00:00Z', rows);
    expect(demanded.needsSnapshot).toBe(true);
    expect(demanded.maxSeq).toBe(4);
    expect(demanded.sources).toEqual(rows);
  });

  it('stream freshness with nothing new is still a no-op', () => {
    const rows = [{ sourceId: SNPP, lastObservedAt: '2026-08-09T09:55:00Z' }];
    const state = stateWith([makeEvent('a', 4)], { sources: rows });
    expect(applyStreamFreshness(state, 4, '2026-08-09T09:00:00Z', rows)).toBe(state);
    expect(applyStreamFreshness(state, 4, '2026-08-09T09:00:00Z')).toBe(state);
  });

  it('mergeSourceRows returns the current array when nothing moved', () => {
    const current = [{ sourceId: SNPP, lastObservedAt: '2026-08-09T09:40:00Z' }];
    expect(mergeSourceRows(current, [])).toBe(current);
    expect(mergeSourceRows(current, [...current])).toBe(current);
  });

  it('mergeSourceRows fills a never-observed source once it is observed', () => {
    const current = [{ sourceId: MODIS, lastObservedAt: null }];
    expect(
      mergeSourceRows(current, [{ sourceId: MODIS, lastObservedAt: '2026-08-09T09:40:00Z' }]),
    ).toEqual([{ sourceId: MODIS, lastObservedAt: '2026-08-09T09:40:00Z' }]);
  });
});
