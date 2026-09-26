import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../ports/clock.js';
import type { FeedAttempt, FeedStatusStore } from '../ports/feed-status-store.js';
import type { ObjectStore, ObjectToStore } from '../ports/object-store.js';
import type { SnapshotReader } from '../ports/snapshot-reader.js';
import { mirrorPushFailed, runMirrorPush, type MirrorPushDeps } from './mirror-push.js';

function reader(maxSeq = 7): SnapshotReader & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    readActiveSet(afterSeq) {
      calls.push(afterSeq);
      return Promise.resolve({ maxSeq, events: [] });
    },
    readSourceObservations(ids) {
      return Promise.resolve(ids.map((sourceId) => ({ sourceId, lastObservedAt: null })));
    },
  };
}

function store(fail: string | null = null): ObjectStore & { puts: ObjectToStore[] } {
  const puts: ObjectToStore[] = [];
  return {
    puts,
    put(object) {
      if (fail !== null) return Promise.reject(new Error(fail));
      puts.push(object);
      return Promise.resolve({ etag: '"e1"' });
    },
    head() {
      return Promise.resolve(null);
    },
  };
}

function feed(): FeedStatusStore & { attempts: FeedAttempt[] } {
  const attempts: FeedAttempt[] = [];
  return {
    attempts,
    recordAttempt(attempt) {
      attempts.push(attempt);
      return Promise.resolve();
    },
  };
}

function deps(overrides: Partial<MirrorPushDeps> = {}): MirrorPushDeps {
  return {
    reader: reader(),
    store: store(),
    clock: new VirtualClock('2026-07-14T10:15:00Z'),
    sources: ['firms-viirs-noaa20'],
    objectKey: 'snapshot.json',
    feedStatus: feed(),
    ...overrides,
  };
}

describe('runMirrorPush', () => {
  it('uploads the full snapshot and records a successful snapshot-push attempt', async () => {
    const r = reader();
    const s = store();
    const f = feed();
    const report = await runMirrorPush(deps({ reader: r, store: s, feedStatus: f }));

    expect(r.calls).toEqual([0]);
    expect(s.puts).toHaveLength(1);
    expect(JSON.parse(s.puts[0]?.body ?? '')).toMatchObject({
      generated_at: '2026-07-14T10:15:00Z',
      max_seq: 7,
      partial: false,
    });
    expect(report).toMatchObject({ outcome: 'uploaded', max_seq: 7, etag: '"e1"' });
    expect(mirrorPushFailed(report)).toBe(false);
    expect(f.attempts).toEqual([
      {
        row: 'snapshot-push',
        attemptAt: Date.parse('2026-07-14T10:15:00Z'),
        succeeded: true,
        hadData: true,
        error: null,
      },
    ]);
  });

  it('re-uploads with a fresh generated_at even when max_seq has not moved', async () => {
    const clock = new VirtualClock('2026-07-14T10:15:00Z');
    const s = store();
    const d = deps({ clock, store: s });
    await runMirrorPush(d);
    clock.advanceMinutes(1);
    await runMirrorPush(d);
    expect(s.puts.map((put) => put.metadata['generated-at'])).toEqual([
      '2026-07-14T10:15:00Z',
      '2026-07-14T10:16:00Z',
    ]);
    expect(s.puts[0]?.body).not.toBe(s.puts[1]?.body);
  });

  it('records a failed upload, with its stage, instead of throwing', async () => {
    const f = feed();
    const report = await runMirrorPush(
      deps({ store: store('R2 PUT x failed: HTTP 503'), feedStatus: f }),
    );
    expect(report).toMatchObject({ outcome: 'failed', stage: 'upload' });
    expect(mirrorPushFailed(report)).toBe(true);
    expect(f.attempts[0]).toMatchObject({
      succeeded: false,
      hadData: false,
      error: 'upload: R2 PUT x failed: HTTP 503',
    });
  });

  it('records a failed read without touching the store', async () => {
    const s = store();
    const broken: SnapshotReader = {
      readActiveSet: () => Promise.reject(new Error('statement timeout')),
      readSourceObservations: () => Promise.resolve([]),
    };
    const report = await runMirrorPush(deps({ reader: broken, store: s }));
    expect(report).toMatchObject({ outcome: 'failed', stage: 'read', error: 'statement timeout' });
    expect(s.puts).toEqual([]);
  });

  it('runs without a feed-status store, claiming nothing', async () => {
    const report = await runMirrorPush(deps({ feedStatus: null }));
    expect(report.outcome).toBe('uploaded');
  });
});
