/**
 * Selector tests: recency ordering (including mixed fractional-second timestamps, which
 * do not compare lexicographically), permalink resolution across merge tombstones
 * (ADR-002 I1), and the map-visibility filter (review 08 §5.2.4 rule 2).
 */

import { describe, expect, it } from 'vitest';

import type { FireEvent } from '../types.js';
import { resolveEvent, sortedEvents, visibleMapEvents } from './selectors.js';

function makeEvent(key: string, seq: number, overrides: Partial<FireEvent> = {}): FireEvent {
  return {
    id: `fw-2026-${key}`,
    seq,
    status: 'active',
    scoreBucket: 'likely',
    mergedInto: null,
    lon: 24.5,
    lat: 42.1,
    firstObservedAt: '2026-08-08T10:00:00Z',
    lastObservedAt: '2026-08-08T12:00:00Z',
    detectionCount: 2,
    placeNameBg: 'Сакар',
    placeNameEn: 'Sakar',
    areaHa: null,
    nextPassWindow: null,
    ...overrides,
  };
}

function stateOf(...events: readonly FireEvent[]): { events: ReadonlyMap<string, FireEvent> } {
  return { events: new Map(events.map((event) => [event.id, event])) };
}

function idsOf(events: readonly FireEvent[]): readonly string[] {
  return events.map((event) => event.id);
}

describe('sortedEvents', () => {
  it('orders by lastObservedAt descending', () => {
    const state = stateOf(
      makeEvent('a', 1, { lastObservedAt: '2026-08-08T10:00:00Z' }),
      makeEvent('b', 2, { lastObservedAt: '2026-08-08T12:00:00Z' }),
      makeEvent('c', 3, { lastObservedAt: '2026-08-08T11:00:00Z' }),
    );

    expect(idsOf(sortedEvents(state))).toEqual(['fw-2026-b', 'fw-2026-c', 'fw-2026-a']);
  });

  it('compares timestamps by instant, not lexicographically, across precision styles', () => {
    // Lexicographically '2026-08-08T12:00:00.500Z' < '2026-08-08T12:00:00Z' (('.' < 'Z');
    // by instant it is the later one.
    const state = stateOf(
      makeEvent('plain', 1, { lastObservedAt: '2026-08-08T12:00:00Z' }),
      makeEvent('fractional', 2, { lastObservedAt: '2026-08-08T12:00:00.500Z' }),
    );

    expect(idsOf(sortedEvents(state))).toEqual(['fw-2026-fractional', 'fw-2026-plain']);
  });

  it('breaks recency ties by public id and sorts malformed timestamps last', () => {
    const state = stateOf(
      makeEvent('b', 2, { lastObservedAt: '2026-08-08T12:00:00Z' }),
      makeEvent('a', 1, { lastObservedAt: '2026-08-08T12:00:00Z' }),
      makeEvent('broken', 3, { lastObservedAt: 'not-a-timestamp' }),
    );

    expect(idsOf(sortedEvents(state))).toEqual(['fw-2026-a', 'fw-2026-b', 'fw-2026-broken']);
  });
});

describe('resolveEvent', () => {
  it('resolves a live event directly, with resolvedFrom null', () => {
    const state = stateOf(makeEvent('a', 1));

    const resolved = resolveEvent(state, 'fw-2026-a');

    expect(resolved?.event.id).toBe('fw-2026-a');
    expect(resolved?.resolvedFrom).toBeNull();
  });

  it('returns null for an id the store does not know', () => {
    expect(resolveEvent(stateOf(makeEvent('a', 1)), 'fw-2026-missing')).toBeNull();
  });

  it('follows a tombstone to its survivor and reports the requested id', () => {
    const state = stateOf(
      makeEvent('gone', 1, { mergedInto: 'fw-2026-survivor' }),
      makeEvent('survivor', 2),
    );

    const resolved = resolveEvent(state, 'fw-2026-gone');

    expect(resolved?.event.id).toBe('fw-2026-survivor');
    expect(resolved?.resolvedFrom).toBe('fw-2026-gone');
  });

  it('follows a multi-hop chain (client-side skew before path compression catches up)', () => {
    const state = stateOf(
      makeEvent('first', 1, { mergedInto: 'fw-2026-second' }),
      makeEvent('second', 2, { mergedInto: 'fw-2026-third' }),
      makeEvent('third', 3),
    );

    const resolved = resolveEvent(state, 'fw-2026-first');

    expect(resolved?.event.id).toBe('fw-2026-third');
    expect(resolved?.resolvedFrom).toBe('fw-2026-first');
  });

  it('settles on the tombstone itself when its survivor is not in the store', () => {
    const state = stateOf(makeEvent('gone', 1, { mergedInto: 'fw-2026-elsewhere' }));

    const resolved = resolveEvent(state, 'fw-2026-gone');

    expect(resolved?.event.id).toBe('fw-2026-gone');
    expect(resolved?.resolvedFrom).toBeNull();
  });

  it('terminates on a contract-violating cycle instead of hanging', () => {
    const state = stateOf(
      makeEvent('a', 1, { mergedInto: 'fw-2026-b' }),
      makeEvent('b', 2, { mergedInto: 'fw-2026-a' }),
    );

    const resolved = resolveEvent(state, 'fw-2026-a');

    expect(resolved?.event.id).toBe('fw-2026-b');
    expect(resolved?.resolvedFrom).toBe('fw-2026-a');
  });
});

describe('visibleMapEvents', () => {
  it('excludes archived events and merge tombstones, keeps every other lifecycle state', () => {
    const state = stateOf(
      makeEvent('active', 1, { status: 'active', lastObservedAt: '2026-08-08T12:05:00Z' }),
      makeEvent('weakening', 2, {
        status: 'signal_weakening',
        lastObservedAt: '2026-08-08T12:04:00Z',
      }),
      makeEvent('faded', 3, {
        status: 'no_longer_detected',
        lastObservedAt: '2026-08-08T12:03:00Z',
      }),
      makeEvent('contained', 4, {
        status: 'officially_contained',
        lastObservedAt: '2026-08-08T12:02:00Z',
      }),
      makeEvent('out', 5, {
        status: 'officially_extinguished',
        lastObservedAt: '2026-08-08T12:01:00Z',
      }),
      makeEvent('archived', 6, { status: 'archived' }),
      makeEvent('tombstone', 7, { mergedInto: 'fw-2026-active' }),
    );

    expect(idsOf(visibleMapEvents(state))).toEqual([
      'fw-2026-active',
      'fw-2026-weakening',
      'fw-2026-faded',
      'fw-2026-contained',
      'fw-2026-out',
    ]);
  });

  it('returns events most recently observed first', () => {
    const state = stateOf(
      makeEvent('older', 1, { lastObservedAt: '2026-08-08T11:00:00Z' }),
      makeEvent('newer', 2, { lastObservedAt: '2026-08-08T12:00:00Z' }),
    );

    expect(idsOf(visibleMapEvents(state))).toEqual(['fw-2026-newer', 'fw-2026-older']);
  });
});
