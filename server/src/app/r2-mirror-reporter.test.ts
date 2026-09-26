import type { HeartbeatJobId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { MirrorAgeVerdict } from '../core/snapshot/mirror-age.js';
import type { MirrorPushReport } from '../core/snapshot/mirror-push.js';
import { reportMirrorAge, reportMirrorPush } from './r2-mirror-reporter.js';

function harness() {
  const lines: string[] = [];
  const pings: HeartbeatJobId[] = [];
  return {
    lines,
    pings,
    deps: {
      writeLine: (line: string) => lines.push(line),
      heartbeat: {
        succeeded: (job: HeartbeatJobId) => {
          pings.push(job);
          return Promise.resolve();
        },
      },
    },
  };
}

function run<T>(value: T | undefined, error?: unknown): JobRun<T> {
  return {
    value,
    error,
    startedAt: '2026-07-14T10:15:00Z',
    finishedAt: '2026-07-14T10:15:01Z',
  } as unknown as JobRun<T>;
}

const UPLOADED: MirrorPushReport = {
  outcome: 'uploaded',
  key: 'snapshot.json',
  generated_at: '2026-07-14T10:15:00Z',
  max_seq: 7,
  features: 0,
  bytes: 120,
  etag: '"e1"',
  duration_ms: 40,
};

describe('reportMirrorPush', () => {
  it('pings snapshot-push on an upload', async () => {
    const h = harness();
    await reportMirrorPush(run(UPLOADED), h.deps);
    expect(h.pings).toEqual(['snapshot-push']);
    expect(JSON.parse(h.lines[0] ?? '')).toEqual({ degraded: false, r2_mirror_push: UPLOADED });
  });

  it('stays silent to the heartbeat on a failed push', async () => {
    const h = harness();
    await reportMirrorPush(
      run<MirrorPushReport>({
        outcome: 'failed',
        key: 'snapshot.json',
        stage: 'upload',
        error: 'HTTP 503',
        duration_ms: 9,
      }),
      h.deps,
    );
    expect(h.pings).toEqual([]);
    expect(JSON.parse(h.lines[0] ?? '')).toMatchObject({ degraded: true });
  });

  it('logs a thrown run and does not ping', async () => {
    const h = harness();
    await reportMirrorPush(run<MirrorPushReport>(undefined, new Error('disk full')), h.deps);
    expect(h.pings).toEqual([]);
    expect(JSON.parse(h.lines[0] ?? '')).toEqual({
      r2_mirror_push_failed: { error: 'disk full', at: '2026-07-14T10:15:01Z' },
    });
  });
});

describe('reportMirrorAge', () => {
  const verdict = (level: MirrorAgeVerdict['level']): MirrorAgeVerdict => ({
    level,
    reason: level === 'ok' ? 'fresh' : 'stale',
    age_seconds: level === 'ok' ? 30 : 400,
    anchor: 'metadata',
    generated_at: '2026-07-14T10:08:20Z',
    warn_seconds: 300,
    critical_seconds: 900,
    status: 200,
    detail: null,
  });

  it('marks anything but ok as degraded', () => {
    const h = harness();
    reportMirrorAge(run(verdict('ok')), h.deps);
    reportMirrorAge(run(verdict('warn')), h.deps);
    expect(h.lines.map((line) => (JSON.parse(line) as { degraded: boolean }).degraded)).toEqual([
      false,
      true,
    ]);
  });

  it('logs a thrown run', () => {
    const h = harness();
    reportMirrorAge(run<MirrorAgeVerdict>(undefined, 'boom'), h.deps);
    expect(JSON.parse(h.lines[0] ?? '')).toEqual({
      r2_mirror_age_failed: { error: 'boom', at: '2026-07-14T10:15:01Z' },
    });
  });
});
