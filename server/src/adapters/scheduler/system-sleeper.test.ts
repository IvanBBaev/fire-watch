import { describe, expect, it } from 'vitest';

import { systemSleeper } from './system-sleeper.js';

describe('systemSleeper', () => {
  it('waits about as long as it was asked to', async () => {
    const started = process.hrtime.bigint();

    await systemSleeper.sleep(25, new AbortController().signal);

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // A lower bound only: a loaded CI runner is allowed to be late, never early.
    expect(elapsedMs).toBeGreaterThanOrEqual(20);
  });

  it('returns immediately, and without throwing, when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = process.hrtime.bigint();

    // An hour-long pause that resolves at once is the whole point: SIGTERM must not have
    // to wait out the interval.
    await expect(systemSleeper.sleep(3_600_000, controller.signal)).resolves.toBeUndefined();

    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1_000);
  });

  it('cuts a pause short when the signal aborts mid-sleep', async () => {
    const controller = new AbortController();
    const started = process.hrtime.bigint();

    const pause = systemSleeper.sleep(3_600_000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await pause;

    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1_000);
  });
});
