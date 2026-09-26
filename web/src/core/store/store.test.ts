/**
 * Wiring tests for the store shell: dispatch routing, notify-only-on-exposed-change,
 * tombstone age-out against server time, freshness and feed-status handling,
 * snapshot-need acknowledgement, and subscription mechanics. Reconciliation *rules* are
 * covered in `reconciler.test.ts` / the property suite; here the reconciler is exercised
 * only enough to prove the store commits and notifies right.
 */

import { describe, expect, it } from 'vitest';

import type { FreshnessReport } from '@fire-watch/contracts';

import type { FireEvent, FireEventStore, Snapshot } from '../types.js';
import { TOMBSTONE_TTL_MS } from './reconciler.js';
import { createFireEventStore } from './store.js';

const SERVER_NOW_MS = Date.parse('2026-08-08T13:00:00Z');

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
    firstObservedAt: '2026-08-08T11:02:00Z',
    lastObservedAt: '2026-08-08T12:47:00Z',
    detectionCount: 3,
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
    schemaVersion: 2,
    generatedAt: '2026-08-08T13:00:00Z',
    maxSeq: Math.max(0, ...events.map((event) => event.seq)),
    partial: false,
    events,
    sources: [],
    ...overrides,
  };
}

function makeReport(generatedAt: string): FreshnessReport {
  return { generatedAt, status: 'ok', budgetVersion: 'v1', rows: [] };
}

function makeStore(serverNowMs = SERVER_NOW_MS): {
  store: FireEventStore;
  notifications: () => number;
} {
  const store = createFireEventStore({ serverNow: () => serverNowMs });
  let count = 0;
  store.subscribe(() => {
    count += 1;
  });
  return { store, notifications: () => count };
}

describe('createFireEventStore', () => {
  it('starts empty: connecting, no freshness, no snapshot owed', () => {
    const store = createFireEventStore({ serverNow: () => SERVER_NOW_MS });
    const state = store.state();
    expect(state.events.size).toBe(0);
    expect(state.maxSeq).toBe(0);
    expect(state.lastSnapshotAt).toBeNull();
    expect(state.freshness).toBeNull();
    expect(state.feedStatus).toBe('connecting');
    expect(state.needsSnapshot).toBe(false);
  });

  it('returns the same state reference between dispatches', () => {
    const { store } = makeStore();
    expect(store.state()).toBe(store.state());
  });

  describe('dispatch', () => {
    it('commits a full snapshot and notifies once', () => {
      const { store, notifications } = makeStore();
      const snapshot = makeSnapshot({ events: [makeEvent('a', 4)] });

      store.dispatch({ kind: 'snapshot', snapshot });

      expect(notifications()).toBe(1);
      const state = store.state();
      expect(state.events.get('a')?.seq).toBe(4);
      expect(state.maxSeq).toBe(4);
      expect(state.lastSnapshotAt).toBe(snapshot.generatedAt);
    });

    it('keys every event on its public id — the only identifier since schema v2', () => {
      const { store } = makeStore();
      const q = makeEvent('fw-2026-q7f3d', 4);
      const b = makeEvent('fw-2026-b2n5c', 3);

      store.dispatch({ kind: 'snapshot', snapshot: makeSnapshot({ events: [q, b] }) });

      const state = store.state();
      expect([...state.events.keys()].sort()).toEqual(['fw-2026-b2n5c', 'fw-2026-q7f3d']);
      for (const [key, event] of state.events) {
        expect(key).toBe(event.id);
        expect(Object.keys(event)).not.toContain('uuid');
      }
      // A later copy under the same public id replaces, never duplicates.
      store.dispatch({ kind: 'delta', events: [{ ...q, seq: 5 }] });
      expect(store.state().events.size).toBe(2);
      expect(store.state().events.get('fw-2026-q7f3d')?.seq).toBe(5);
    });

    it('does not notify when re-dispatching the same snapshot (no-op commit)', () => {
      const { store, notifications } = makeStore();
      const snapshot = makeSnapshot({ events: [makeEvent('a', 4)] });
      store.dispatch({ kind: 'snapshot', snapshot });
      const settled = store.state();

      store.dispatch({ kind: 'snapshot', snapshot });

      expect(notifications()).toBe(1);
      expect(store.state()).toBe(settled);
    });

    it('commits a delta and notifies', () => {
      const { store, notifications } = makeStore();
      store.dispatch({ kind: 'snapshot', snapshot: makeSnapshot({ events: [makeEvent('a', 4)] }) });

      store.dispatch({ kind: 'delta', events: [makeEvent('a', 5, { detectionCount: 7 })] });

      expect(notifications()).toBe(2);
      expect(store.state().events.get('a')?.detectionCount).toBe(7);
    });

    it('does not notify on a stale delta', () => {
      const { store, notifications } = makeStore();
      store.dispatch({ kind: 'snapshot', snapshot: makeSnapshot({ events: [makeEvent('a', 4)] }) });
      const settled = store.state();

      store.dispatch({ kind: 'delta', events: [makeEvent('a', 3, { detectionCount: 99 })] });

      expect(notifications()).toBe(1);
      expect(store.state()).toBe(settled);
    });

    it('reset keeps the events and cursor, raises needsSnapshot, keeps freshness and feedStatus', () => {
      const { store, notifications } = makeStore();
      store.dispatch({ kind: 'snapshot', snapshot: makeSnapshot({ events: [makeEvent('a', 4)] }) });
      store.dispatch({ kind: 'freshness', report: makeReport('2026-08-08T13:05:00Z') });
      store.setFeedStatus('live');
      const events = store.state().events;
      const before = notifications();

      store.dispatch({ kind: 'reset' });

      expect(notifications()).toBe(before + 1);
      const state = store.state();
      expect(state.events).toBe(events);
      expect(state.maxSeq).toBe(4);
      expect(state.needsSnapshot).toBe(true);
      expect(state.freshness?.generatedAt).toBe('2026-08-08T13:05:00Z');
      expect(state.feedStatus).toBe('live');
    });

    it('does not notify a second reset — the demand is already up', () => {
      const { store, notifications } = makeStore();
      store.dispatch({ kind: 'reset' });

      store.dispatch({ kind: 'reset' });

      expect(notifications()).toBe(1);
    });

    it('notifies once per exposed change, whatever the reconciler touched besides', () => {
      const { store, notifications } = makeStore();
      // Two events in one snapshot: one notification, not one per event.
      store.dispatch({
        kind: 'snapshot',
        snapshot: makeSnapshot({ events: [makeEvent('a', 4), makeEvent('b', 5)] }),
      });
      expect(notifications()).toBe(1);

      // An absence noted and the anchor moved in one message: still one notification.
      store.dispatch({
        kind: 'snapshot',
        snapshot: makeSnapshot({
          events: [makeEvent('a', 4)],
          maxSeq: 5,
          generatedAt: '2026-08-08T13:01:00Z',
        }),
      });
      expect(notifications()).toBe(2);
      expect(store.state().lastSnapshotAt).toBe('2026-08-08T13:01:00Z');
    });

    it('persists a bookkeeping-only change without notifying', () => {
      const { store, notifications } = makeStore();
      store.dispatch({
        kind: 'snapshot',
        snapshot: makeSnapshot({ events: [makeEvent('a', 4), makeEvent('b', 10)] }),
      });
      const settled = store.state();

      // An older cached copy that omits `b` and cannot prove it gone (its maxSeq predates
      // `b`), at the same instant: the absence is noted, nothing visible changes.
      store.dispatch({
        kind: 'snapshot',
        snapshot: makeSnapshot({ events: [makeEvent('a', 4)], maxSeq: 5 }),
      });
      expect(notifications()).toBe(1);
      expect(store.state()).toBe(settled);

      // ...but the note was kept: a second such absence at a higher maxSeq removes `b`
      // although this snapshot cannot prove it gone on its own either.
      store.dispatch({
        kind: 'snapshot',
        snapshot: makeSnapshot({ events: [makeEvent('a', 4)], maxSeq: 6 }),
      });
      expect(notifications()).toBe(2);
      expect(store.state().events.has('b')).toBe(false);
      expect(store.state().maxSeq).toBe(10);
    });

    it('ages out a tombstone against server time after a snapshot or delta lands', () => {
      const mergedAt = '2026-08-08T12:00:00Z';
      const { store, notifications } = makeStore(Date.parse(mergedAt) + TOMBSTONE_TTL_MS);
      store.dispatch({
        kind: 'snapshot',
        snapshot: makeSnapshot({
          events: [makeEvent('w', 4)],
          generatedAt: '2026-08-08T11:00:00Z',
        }),
      });
      const tombstone = makeEvent('t', 5, { status: 'archived', mergedInto: 'w' });

      store.dispatch({ kind: 'delta', events: [tombstone], generatedAt: mergedAt });

      // Applied and expired within the same dispatch: the exposed set never held it.
      expect(store.state().events.has('t')).toBe(false);
      expect(store.state().maxSeq).toBe(5);
      expect(notifications()).toBe(2);
    });

    it('keeps a tombstone that is younger than the TTL in server time', () => {
      const mergedAt = '2026-08-08T12:00:00Z';
      const { store } = makeStore(Date.parse(mergedAt) + TOMBSTONE_TTL_MS - 1);
      store.dispatch({ kind: 'snapshot', snapshot: makeSnapshot({ events: [makeEvent('w', 4)] }) });
      const tombstone = makeEvent('t', 5, { status: 'archived', mergedInto: 'w' });

      store.dispatch({ kind: 'delta', events: [tombstone], generatedAt: mergedAt });

      expect(store.state().events.get('t')).toBe(tombstone);
    });

    it('stream-freshness ahead of the cursor demands a snapshot without moving maxSeq', () => {
      const { store, notifications } = makeStore();
      store.dispatch({ kind: 'snapshot', snapshot: makeSnapshot({ events: [makeEvent('a', 4)] }) });

      store.dispatch({
        kind: 'stream-freshness',
        generatedAt: '2026-08-08T13:10:00Z',
        maxSeq: 6,
        sources: [],
      });

      expect(notifications()).toBe(2);
      expect(store.state().needsSnapshot).toBe(true);
      expect(store.state().maxSeq).toBe(4);
      expect(store.state().lastSnapshotAt).toBe('2026-08-08T13:00:00Z');
    });

    it('stream-freshness at the cursor confirms the anchor', () => {
      const { store, notifications } = makeStore();
      store.dispatch({ kind: 'snapshot', snapshot: makeSnapshot({ events: [makeEvent('a', 4)] }) });

      store.dispatch({
        kind: 'stream-freshness',
        generatedAt: '2026-08-08T13:10:00Z',
        maxSeq: 4,
        sources: [],
      });

      expect(notifications()).toBe(2);
      expect(store.state().needsSnapshot).toBe(false);
      expect(store.state().lastSnapshotAt).toBe('2026-08-08T13:10:00Z');
    });

    it('snapshot-confirmed advances the anchor and is a no-op when not newer', () => {
      const { store, notifications } = makeStore();
      store.dispatch({ kind: 'snapshot', snapshot: makeSnapshot({ events: [makeEvent('a', 4)] }) });

      store.dispatch({ kind: 'snapshot-confirmed', generatedAt: '2026-08-08T13:10:00Z' });
      store.dispatch({ kind: 'snapshot-confirmed', generatedAt: '2026-08-08T13:05:00Z' });

      expect(notifications()).toBe(2);
      expect(store.state().lastSnapshotAt).toBe('2026-08-08T13:10:00Z');
    });

    it('snapshot-confirmed before any snapshot is a no-op', () => {
      const { store, notifications } = makeStore();

      store.dispatch({ kind: 'snapshot-confirmed', generatedAt: '2026-08-08T13:10:00Z' });

      expect(notifications()).toBe(0);
      expect(store.state().lastSnapshotAt).toBeNull();
    });

    it('stores a freshness report and notifies', () => {
      const { store, notifications } = makeStore();
      const report = makeReport('2026-08-08T13:05:00Z');

      store.dispatch({ kind: 'freshness', report });

      expect(notifications()).toBe(1);
      expect(store.state().freshness).toBe(report);
    });

    it('ignores a re-delivered freshness report (same reference or same generatedAt)', () => {
      const { store, notifications } = makeStore();
      const report = makeReport('2026-08-08T13:05:00Z');
      store.dispatch({ kind: 'freshness', report });

      store.dispatch({ kind: 'freshness', report });
      store.dispatch({ kind: 'freshness', report: makeReport('2026-08-08T13:05:00Z') });

      expect(notifications()).toBe(1);
      expect(store.state().freshness).toBe(report);
    });

    it('replaces the freshness report when a newer generation arrives', () => {
      const { store, notifications } = makeStore();
      store.dispatch({ kind: 'freshness', report: makeReport('2026-08-08T13:05:00Z') });

      store.dispatch({ kind: 'freshness', report: makeReport('2026-08-08T13:20:00Z') });

      expect(notifications()).toBe(2);
      expect(store.state().freshness?.generatedAt).toBe('2026-08-08T13:20:00Z');
    });
  });

  describe('setFeedStatus', () => {
    it('notifies on a change and not on the same value', () => {
      const { store, notifications } = makeStore();

      store.setFeedStatus('live');
      store.setFeedStatus('live');

      expect(notifications()).toBe(1);
      expect(store.state().feedStatus).toBe('live');
    });
  });

  describe('acknowledgeSnapshotNeed', () => {
    it('lowers the flag and notifies once; a second call is a no-op', () => {
      const { store, notifications } = makeStore();
      store.dispatch({ kind: 'reset' });
      const before = notifications();

      store.acknowledgeSnapshotNeed();
      store.acknowledgeSnapshotNeed();

      expect(notifications()).toBe(before + 1);
      expect(store.state().needsSnapshot).toBe(false);
    });

    it('is a no-op when the flag was never raised', () => {
      const { store, notifications } = makeStore();

      store.acknowledgeSnapshotNeed();

      expect(notifications()).toBe(0);
    });
  });

  describe('subscribe', () => {
    it('notifies every listener and stops after unsubscribe', () => {
      const store = createFireEventStore({ serverNow: () => SERVER_NOW_MS });
      let first = 0;
      let second = 0;
      const unsubscribeFirst = store.subscribe(() => {
        first += 1;
      });
      store.subscribe(() => {
        second += 1;
      });

      store.setFeedStatus('live');
      unsubscribeFirst();
      store.setFeedStatus('degraded');

      expect(first).toBe(1);
      expect(second).toBe(2);
    });

    it('survives a listener unsubscribing itself mid-notification', () => {
      const store = createFireEventStore({ serverNow: () => SERVER_NOW_MS });
      let selfCalls = 0;
      let siblingCalls = 0;
      const unsubscribeSelf = store.subscribe(() => {
        selfCalls += 1;
        unsubscribeSelf();
      });
      store.subscribe(() => {
        siblingCalls += 1;
      });

      store.setFeedStatus('live');
      store.setFeedStatus('degraded');

      expect(selfCalls).toBe(1);
      expect(siblingCalls).toBe(2);
    });
  });
});

describe('per-source recency (F4)', () => {
  const ROW = { sourceId: 'firms:viirs:snpp', lastObservedAt: '2026-08-08T12:40:00Z' };

  it('exposes the snapshot sources and starts empty', () => {
    const { store } = makeStore();
    expect(store.state().sources).toEqual([]);
    store.dispatch({ kind: 'snapshot', snapshot: makeSnapshot({ sources: [ROW] }) });
    expect(store.state().sources).toEqual([ROW]);
  });

  it('announces a stream frame that moved only a source, once', () => {
    const { store, notifications } = makeStore();
    store.dispatch({
      kind: 'snapshot',
      snapshot: makeSnapshot({ events: [makeEvent('a', 4)], sources: [ROW] }),
    });
    const newer = { ...ROW, lastObservedAt: '2026-08-08T12:55:00Z' };

    // Older than the anchor, so only the source row can move.
    const frame = {
      kind: 'stream-freshness',
      generatedAt: '2026-08-08T12:00:00Z',
      maxSeq: 4,
      sources: [newer],
    } as const;
    store.dispatch(frame);
    expect(notifications()).toBe(2);
    expect(store.state().sources).toEqual([newer]);
    expect(store.state().lastSnapshotAt).toBe('2026-08-08T13:00:00Z');

    store.dispatch(frame);
    expect(notifications()).toBe(2);
  });
});
