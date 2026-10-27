import { describe, expect, it } from 'vitest';

import type { JobRun, JobSkip } from '../core/scheduler/repeating-job.js';
import { SKIP_LOG_EVERY, skipLog } from './loop-lock-wiring.js';

const SKIP: JobSkip = { startedAt: 0, finishedAt: 5, reason: 'lock_held' };
const RUN: JobRun<string> = { startedAt: 0, finishedAt: 5, value: 'ok', error: null };

describe('skipLog', () => {
  it('notes the start of a standby streak, then every SKIP_LOG_EVERY skips, then the takeover', async () => {
    const notes: Record<string, unknown>[] = [];
    const log = skipLog('dispatch', (record) => notes.push(record));
    const reported: JobRun<string>[] = [];
    const report = log.ran((run: JobRun<string>) => {
      reported.push(run);
    });

    for (let i = 0; i < SKIP_LOG_EVERY + 1; i += 1) log.skipped(SKIP);
    await report(RUN);
    log.skipped(SKIP);

    expect(notes).toEqual([
      { loop_skipped: { loop: 'dispatch', reason: 'lock_held', consecutive: 1 } },
      { loop_skipped: { loop: 'dispatch', reason: 'lock_held', consecutive: SKIP_LOG_EVERY } },
      { loop_lock_acquired: { loop: 'dispatch', after_skips: SKIP_LOG_EVERY + 1 } },
      // A new streak after the run starts counting again.
      { loop_skipped: { loop: 'dispatch', reason: 'lock_held', consecutive: 1 } },
    ]);
    expect(reported).toEqual([RUN]);
  });

  it('stays quiet for a holder that never skipped', async () => {
    const notes: unknown[] = [];
    const log = skipLog('ingest', (record) => notes.push(record));
    await log.ran(() => undefined)(RUN);
    expect(notes).toEqual([]);
  });
});
