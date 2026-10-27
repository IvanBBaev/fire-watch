import { describe, expect, it } from 'vitest';

import { eventPageState, eventPath, redirectTargetFor } from './event-resolution.js';
import type { EventPageInputs } from './event-resolution.js';

describe('eventPath', () => {
  it('builds the canonical event route', () => {
    expect(eventPath('fw-2026-q7f3d')).toBe('/event/fw-2026-q7f3d');
  });
});

describe('redirectTargetFor', () => {
  it('stays put when the id resolves to itself', () => {
    expect(redirectTargetFor('fw-2026-q7f3d', 'fw-2026-q7f3d')).toBeNull();
  });

  it('stays put when nothing resolved (unknown id renders not-found, no redirect)', () => {
    expect(redirectTargetFor('fw-2026-nope0', null)).toBeNull();
  });

  it('redirects a merged tombstone to the survivor path', () => {
    // Fixture: fw-2026-z7c3f was merged into fw-2026-q7f3d.
    expect(redirectTargetFor('fw-2026-z7c3f', 'fw-2026-q7f3d')).toBe('/event/fw-2026-q7f3d');
  });
});

describe('eventPageState', () => {
  const SNAPSHOT_AT = '2026-08-09T12:00:00Z';
  const live: EventPageInputs = {
    found: false,
    lastSnapshotAt: SNAPSHOT_AT,
    feedStatus: 'live',
    bannerUp: false,
  };

  it('shows a resolved event whatever the feed is doing', () => {
    for (const feedStatus of ['connecting', 'live', 'degraded', 'dead'] as const) {
      expect(eventPageState({ ...live, found: true, feedStatus, bannerUp: true })).toBe('found');
    }
  });

  it('is loading, never not-found, before the first snapshot of a cold permalink open', () => {
    expect(eventPageState({ ...live, lastSnapshotAt: null, feedStatus: 'connecting' })).toBe(
      'loading',
    );
    // `live` before a snapshot is the SSE stream open with its first push not yet in.
    expect(eventPageState({ ...live, lastSnapshotAt: null })).toBe('loading');
  });

  it('could not load, never not-found, when the first snapshot failed', () => {
    for (const feedStatus of ['degraded', 'dead'] as const) {
      expect(eventPageState({ ...live, lastSnapshotAt: null, feedStatus, bannerUp: true })).toBe(
        'unavailable',
      );
    }
  });

  it('could not load, never not-found, from a failing feed or a snapshot under the stale banner', () => {
    expect(eventPageState({ ...live, feedStatus: 'degraded' })).toBe('unavailable');
    expect(eventPageState({ ...live, feedStatus: 'dead', bannerUp: true })).toBe('unavailable');
    expect(eventPageState({ ...live, bannerUp: true })).toBe('unavailable');
  });

  it('says not-found only from a fresh, live snapshot that lacks the id', () => {
    expect(eventPageState(live)).toBe('not-found');
  });
});
