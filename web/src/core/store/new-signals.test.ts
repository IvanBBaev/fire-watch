/**
 * New-signal logic: the first visit counts nothing, new and grown events are diffed and
 * ordered newest first, acknowledgement is per observation, persistence round-trips and
 * survives garbage, pruning is bounded without resurfacing what was seen, and the sound
 * never fires for data older than the viewer's last visit.
 */

import { describe, expect, it } from 'vitest';

import type { FireEvent } from '../types.js';
import {
  baselineSeenState,
  cueKey,
  diffNewSignals,
  markAllSeen,
  markSeen,
  parseSeenState,
  pruneSeen,
  serializeSeenState,
  soundEligible,
  titleWithBadge,
  withLastVisit,
} from './new-signals.js';
import type { SeenState } from './new-signals.js';

const T0 = Date.parse('2026-08-08T12:00:00Z');
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function makeEvent(key: string, observedMs: number, overrides: Partial<FireEvent> = {}): FireEvent {
  return {
    id: `fw-2026-${key}`,
    seq: 1,
    status: 'active',
    scoreBucket: 'likely',
    mergedInto: null,
    lon: 24.5,
    lat: 42.1,
    firstObservedAt: iso(observedMs),
    lastObservedAt: iso(observedMs),
    detectionCount: 2,
    placeNameBg: 'Сакар',
    placeNameEn: 'Sakar',
    areaHa: null,
    nextPassWindow: null,
    ...overrides,
  };
}

function mapOf(...events: readonly FireEvent[]): ReadonlyMap<string, FireEvent> {
  return new Map(events.map((event) => [event.id, event]));
}

const ids = (signals: readonly { readonly id: string }[]): readonly string[] =>
  signals.map((signal) => signal.id);

describe('baselineSeenState / diffNewSignals', () => {
  it('counts nothing on the first visit', () => {
    const events = mapOf(makeEvent('a', T0 - 10 * MIN), makeEvent('b', T0 - 5 * MIN));
    const state = baselineSeenState(events, T0);
    expect(diffNewSignals(events, state)).toEqual([]);
    expect(state.lastVisitMs).toBeNull();
  });

  it('reports unseen events observed after the floor as new, newest first', () => {
    const state = baselineSeenState(mapOf(), T0);
    const events = mapOf(
      makeEvent('a', T0 + 1 * MIN),
      makeEvent('c', T0 + 3 * MIN),
      makeEvent('b', T0 + 3 * MIN),
      makeEvent('old', T0 - MIN),
    );
    const signals = diffNewSignals(events, state);
    expect(ids(signals)).toEqual(['fw-2026-b', 'fw-2026-c', 'fw-2026-a']);
    expect(signals.every((signal) => signal.kind === 'new')).toBe(true);
  });

  it('reports a seen event that was observed again or gained detections as updated', () => {
    const before = mapOf(makeEvent('a', T0 - MIN), makeEvent('b', T0 - MIN));
    const state = baselineSeenState(before, T0);
    const after = mapOf(
      makeEvent('a', T0 + 2 * MIN),
      makeEvent('b', T0 - MIN, { detectionCount: 5 }),
    );
    const signals = diffNewSignals(after, state);
    expect(ids(signals)).toEqual(['fw-2026-a', 'fw-2026-b']);
    expect(signals.map((signal) => signal.kind)).toEqual(['updated', 'updated']);
  });

  it('ignores tombstones and events no longer being detected', () => {
    const state = baselineSeenState(mapOf(), T0);
    const events = mapOf(
      makeEvent('merged', T0 + MIN, { mergedInto: 'fw-2026-x' }),
      makeEvent('quiet', T0 + MIN, { status: 'no_longer_detected' }),
      makeEvent('weak', T0 + MIN, { status: 'signal_weakening' }),
      makeEvent('broken', T0 + MIN, { lastObservedAt: 'not a time' }),
    );
    expect(ids(diffNewSignals(events, state))).toEqual(['fw-2026-weak']);
  });
});

describe('markSeen / markAllSeen', () => {
  it('acknowledges one event at a time, so the next newest leads', () => {
    const state0 = baselineSeenState(mapOf(), T0);
    const events = mapOf(makeEvent('a', T0 + MIN), makeEvent('b', T0 + 2 * MIN));
    const state1 = markSeen(state0, events, ['fw-2026-b']);
    expect(ids(diffNewSignals(events, state1))).toEqual(['fw-2026-a']);
    expect(diffNewSignals(events, markAllSeen(state1, events))).toEqual([]);
  });

  it('returns the same state when nothing changes', () => {
    const events = mapOf(makeEvent('a', T0));
    const state = baselineSeenState(events, T0);
    expect(markSeen(state, events, ['fw-2026-a', 'fw-2026-missing'])).toBe(state);
  });

  it('shows a seen event again when it grows after acknowledgement', () => {
    const first = mapOf(makeEvent('a', T0 + MIN));
    const state = markAllSeen(baselineSeenState(mapOf(), T0), first);
    const grown = mapOf(makeEvent('a', T0 + MIN, { detectionCount: 9 }));
    expect(diffNewSignals(grown, state).map((signal) => signal.kind)).toEqual(['updated']);
  });
});

describe('pruneSeen', () => {
  it('drops records past the horizon and raises the floor over them', () => {
    const events = mapOf(makeEvent('old', T0 - 10 * MIN), makeEvent('fresh', T0));
    const state = baselineSeenState(events, T0 - 20 * MIN);
    const pruned = pruneSeen(state, T0, { horizonMs: 5 * MIN });
    expect([...pruned.seen.keys()]).toEqual(['fw-2026-fresh']);
    expect(pruned.floorMs).toBe(T0 - 10 * MIN);
    // The forgotten event does not come back as new for the observation already seen.
    expect(diffNewSignals(events, pruned)).toEqual([]);
  });

  it('keeps at most maxEntries of the newest records', () => {
    const events = mapOf(
      makeEvent('a', T0 - 3 * MIN),
      makeEvent('b', T0 - 2 * MIN),
      makeEvent('c', T0 - MIN),
    );
    const state = baselineSeenState(events, T0 - 60 * MIN);
    const pruned = pruneSeen(state, T0, { maxEntries: 2 });
    expect([...pruned.seen.keys()].sort()).toEqual(['fw-2026-b', 'fw-2026-c']);
    expect(pruned.floorMs).toBe(T0 - 3 * MIN);
    expect(diffNewSignals(events, pruned)).toEqual([]);
  });

  it('never lowers the floor and is a no-op when nothing is dropped', () => {
    const events = mapOf(makeEvent('a', T0 - MIN));
    const state = baselineSeenState(events, T0);
    expect(pruneSeen(state, T0)).toBe(state);
    expect(pruneSeen(state, T0 + 30 * 24 * 60 * MIN).floorMs).toBe(T0);
  });
});

describe('serializeSeenState / parseSeenState', () => {
  it('round-trips', () => {
    const events = mapOf(makeEvent('a', T0 - MIN, { detectionCount: 4 }));
    const state = withLastVisit(baselineSeenState(events, T0), T0 + MIN);
    const parsed = parseSeenState(serializeSeenState(state));
    expect(parsed).toEqual(state);
  });

  it.each([
    ['absent', null],
    ['not JSON', '{'],
    ['wrong version', JSON.stringify({ v: 2, floorMs: 1, lastVisitMs: null, seen: {} })],
    ['bad floor', JSON.stringify({ v: 1, floorMs: 'x', lastVisitMs: null, seen: {} })],
    ['bad last visit', JSON.stringify({ v: 1, floorMs: 1, lastVisitMs: 'x', seen: {} })],
    ['bad seen', JSON.stringify({ v: 1, floorMs: 1, lastVisitMs: null, seen: [] })],
    ['array root', '[]'],
  ])('rejects %s', (_label, raw) => {
    expect(parseSeenState(raw)).toBeNull();
  });

  it('drops malformed records but keeps the rest', () => {
    const raw = JSON.stringify({
      v: 1,
      floorMs: 5,
      lastVisitMs: null,
      seen: { ok: [10, 2], short: [10], neg: [10, -1], str: ['10', 2] },
    });
    expect([...(parseSeenState(raw)?.seen.keys() ?? [])]).toEqual(['ok']);
  });
});

describe('soundEligible', () => {
  it('never cues data observed at or before the last visit, nor twice', () => {
    const base: SeenState = withLastVisit(baselineSeenState(mapOf(), T0), T0 + 10 * MIN);
    const events = mapOf(makeEvent('before', T0 + 5 * MIN), makeEvent('after', T0 + 15 * MIN));
    const signals = diffNewSignals(events, base);
    expect(ids(signals)).toEqual(['fw-2026-after', 'fw-2026-before']);
    expect(ids(soundEligible(signals, base, new Set()))).toEqual(['fw-2026-after']);
    const cued = new Set([cueKey('fw-2026-after', T0 + 15 * MIN)]);
    expect(soundEligible(signals, base, cued)).toEqual([]);
  });

  it('uses the floor when there has been no earlier visit', () => {
    const base = baselineSeenState(mapOf(), T0);
    const signals = diffNewSignals(mapOf(makeEvent('a', T0 + MIN)), base);
    expect(ids(soundEligible(signals, base, new Set()))).toEqual(['fw-2026-a']);
  });
});

describe('titleWithBadge', () => {
  it('prefixes a count and caps it', () => {
    expect(titleWithBadge('Fire Watch', 0)).toBe('Fire Watch');
    expect(titleWithBadge('Fire Watch', 3)).toBe('(3) Fire Watch');
    expect(titleWithBadge('Fire Watch', 250)).toBe('(99+) Fire Watch');
  });
});
