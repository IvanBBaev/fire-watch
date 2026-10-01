/**
 * The FWI copy is re-validated when its UTC day ends by the server's clock — and not
 * before, not by the device clock, and not in a tight loop while the proxy still serves
 * yesterday's copy.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OverlayLoaderDeps, OverlayStatus } from './layers.js';
import { OVERLAY_URLS, chosenOverlays, overlayStatus, resetOverlaysForTest } from './layers.js';
import {
  MAX_CHECK_INTERVAL_MS,
  ROLLOVER_RETRY_MS,
  WIND_STEP_RETRY_MS,
  planRevalidation,
  planStepRevalidation,
  startOverlayRevalidation,
  validForEndsAtMs,
} from './overlay-refresh.js';

const HOUR = 3_600_000;
const MIDNIGHT = Date.parse('2026-09-29T00:00:00Z');

function ready(validFor: string | null, fetchedAtMs: number): OverlayStatus {
  return {
    kind: 'ready',
    state: 'current',
    availableAt: '2026-09-28T06:30:00.000Z',
    validFor,
    fetchedAtMs,
  };
}

describe('planRevalidation', () => {
  it('ends a valid-for day at the next UTC midnight', () => {
    expect(validForEndsAtMs('2026-09-28')).toBe(MIDNIGHT);
    expect(validForEndsAtMs('not-a-date')).toBeNull();
  });

  it('schedules nothing for a copy with no day, or no copy', () => {
    expect(planRevalidation(ready(null, 0), MIDNIGHT, 0)).toEqual({ kind: 'none' });
    expect(planRevalidation({ kind: 'unavailable' }, MIDNIGHT, 0)).toEqual({ kind: 'none' });
    expect(planRevalidation({ kind: 'loading' }, MIDNIGHT, 0)).toEqual({ kind: 'none' });
  });

  it('waits for midnight, in steps no longer than the check interval', () => {
    expect(planRevalidation(ready('2026-09-28', 0), MIDNIGHT - 20 * 60_000, 0)).toEqual({
      kind: 'wait',
      ms: 20 * 60_000,
    });
    expect(planRevalidation(ready('2026-09-28', 0), MIDNIGHT - 9 * HOUR, 0)).toEqual({
      kind: 'wait',
      ms: MAX_CHECK_INTERVAL_MS,
    });
  });

  it('is due once the server clock passes midnight and the copy is not brand new', () => {
    expect(planRevalidation(ready('2026-09-28', 0), MIDNIGHT, ROLLOVER_RETRY_MS)).toEqual({
      kind: 'due',
    });
  });

  it('retries an out-of-date copy on the cadence, counted from its arrival', () => {
    // Fetched 5 min ago, after midnight, still yesterday's: ask again in 25 min.
    expect(
      planRevalidation(ready('2026-09-28', 100 * HOUR), MIDNIGHT + HOUR, 100 * HOUR + 5 * 60_000),
    ).toEqual({ kind: 'wait', ms: ROLLOVER_RETRY_MS - 5 * 60_000 });
  });

  it('reads the server clock only: a device clock ahead is not an input', () => {
    // The plan takes no device epoch at all — the monotonic clock only measures age.
    expect(planRevalidation(ready('2026-09-29', 0), MIDNIGHT + HOUR, 10 * HOUR)).toEqual({
      kind: 'wait',
      ms: MAX_CHECK_INTERVAL_MS,
    });
  });
});

describe('startOverlayRevalidation', () => {
  beforeEach(() => {
    resetOverlaysForTest();
  });
  afterEach(() => {
    resetOverlaysForTest();
  });

  function harness(validForAnswers: string[]) {
    const clock = { server: MIDNIGHT - 10 * 60_000, mono: 1_000 };
    const requested: string[] = [];
    const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
    const loader: OverlayLoaderDeps = {
      fetch: (url) => {
        requested.push(url);
        const headers = new Headers({
          'x-fire-watch-overlay-state': 'current',
          'x-fire-watch-overlay-available-at': '2026-09-28T06:30:00.000Z',
          'x-fire-watch-overlay-valid-for': validForAnswers.shift() ?? '2026-09-29',
        });
        return Promise.resolve(new Response(new Blob([new Uint8Array([1])]), { headers }));
      },
      createObjectURL: () => 'blob:fwi',
      revokeObjectURL: () => {},
      now: () => clock.mono,
    };
    const stop = startOverlayRevalidation({
      serverNow: () => clock.server,
      loader,
      setTimeout: (callback, ms) => {
        // A fired timer is spent, like a cleared one.
        const timer = {
          callback: () => {
            timer.cleared = true;
            callback();
          },
          ms,
          cleared: false,
        };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    });
    const live = () => timers.filter((timer) => !timer.cleared);
    return { clock, requested, timers, live, stop };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('re-fetches FWI after midnight until a copy for the new day arrives', async () => {
    const h = harness(['2026-09-28']); // the proxy still serves yesterday's copy once
    chosenOverlays.value = ['fwi'];
    overlayStatus.value = { ...overlayStatus.peek(), fwi: ready('2026-09-28', 0) };
    expect(h.live().map((t) => t.ms)).toEqual([10 * 60_000]);
    expect(h.requested).toEqual([]);

    // Midnight by the server clock; the copy is older than the retry cadence.
    h.clock.server = MIDNIGHT + 1;
    h.clock.mono = ROLLOVER_RETRY_MS;
    h.live()[0]?.callback();
    await flush();
    expect(h.requested).toEqual([OVERLAY_URLS.fwi]);
    // Still yesterday's: the next ask waits a full cadence, not a tight loop.
    expect(overlayStatus.value.fwi).toMatchObject({ validFor: '2026-09-28' });
    expect(h.live().map((t) => t.ms)).toEqual([ROLLOVER_RETRY_MS]);

    h.clock.mono += ROLLOVER_RETRY_MS;
    h.live()[0]?.callback();
    await flush();
    expect(h.requested).toEqual([OVERLAY_URLS.fwi, OVERLAY_URLS.fwi]);
    expect(overlayStatus.value.fwi).toMatchObject({ validFor: '2026-09-29' });
    // Today's copy waits for its own midnight (capped at the check interval).
    expect(h.live().map((t) => t.ms)).toEqual([MAX_CHECK_INTERVAL_MS]);
    h.stop();
    expect(h.live()).toEqual([]);
  });

  it('an early wake-up fetches nothing, and a switched-off overlay is not scheduled', async () => {
    const h = harness([]);
    chosenOverlays.value = ['fwi'];
    overlayStatus.value = { ...overlayStatus.peek(), fwi: ready('2026-09-28', 0) };
    h.live()[0]?.callback(); // the server clock has not moved
    await flush();
    expect(h.requested).toEqual([]);
    expect(h.live()).toHaveLength(1);

    chosenOverlays.value = [];
    expect(h.live()).toEqual([]);
    h.stop();
  });
});

// ── Wind (F14): the served forecast step goes out of date as time moves on ──

const WIND_FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../public/fixtures/wind/latest.json', import.meta.url)),
    'utf8',
  ),
) as { valid_at: string; step_hours: number };
const STEP_AT = Date.parse('2026-09-30T06:00:00Z');

function windReady(validAt: string, fetchedAtMs: number): OverlayStatus {
  return { ...ready(null, fetchedAtMs), validAt } as OverlayStatus;
}

describe('planStepRevalidation (wind)', () => {
  it("waits for the shown step's valid instant by the server clock", () => {
    expect(planStepRevalidation('2026-09-30T06:00:00Z', 0, STEP_AT - 40 * 60_000, 0)).toEqual({
      kind: 'wait',
      ms: 40 * 60_000,
    });
    expect(planStepRevalidation('2026-09-30T06:00:00Z', 0, STEP_AT - 5 * HOUR, 0)).toEqual({
      kind: 'wait',
      ms: MAX_CHECK_INTERVAL_MS,
    });
  });

  it('is due once the step is past and the copy is older than the cadence', () => {
    expect(planStepRevalidation('2026-09-30T06:00:00Z', 0, STEP_AT, WIND_STEP_RETRY_MS)).toEqual({
      kind: 'due',
    });
  });

  it('retries a past step on the cadence counted from arrival, never in a tight loop', () => {
    expect(
      planStepRevalidation('2026-09-30T06:00:00Z', 10 * HOUR, STEP_AT + HOUR, 10 * HOUR + 60_000),
    ).toEqual({ kind: 'wait', ms: WIND_STEP_RETRY_MS - 60_000 });
  });

  it('schedules nothing for an unreadable instant', () => {
    expect(planStepRevalidation('soon', 0, STEP_AT, 0)).toEqual({ kind: 'none' });
  });

  it('is what planRevalidation does for a wind copy', () => {
    expect(planRevalidation(windReady('2026-09-30T06:00:00Z', 0), STEP_AT - HOUR / 2, 0)).toEqual({
      kind: 'wait',
      ms: HOUR / 2,
    });
  });
});

describe('startOverlayRevalidation (wind)', () => {
  beforeEach(() => {
    resetOverlaysForTest();
  });
  afterEach(() => {
    resetOverlaysForTest();
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("asks for a new step once the shown one's valid time passes, until one arrives", async () => {
    const shown = WIND_FIXTURE.valid_at;
    const later = new Date(Date.parse(shown) + 6 * HOUR).toISOString().replace('.000Z', 'Z');
    const answers = [shown, later];
    const clock = { server: Date.parse(shown) - HOUR, mono: 1_000 };
    const requested: string[] = [];
    const live: { callback: () => void; ms: number; cleared: boolean }[] = [];
    const stop = startOverlayRevalidation({
      serverNow: () => clock.server,
      loader: {
        fetch: (url) => {
          requested.push(url);
          const body = { ...WIND_FIXTURE, valid_at: answers.shift() ?? later };
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        },
        createObjectURL: () => 'blob:x',
        revokeObjectURL: () => {},
        now: () => clock.mono,
      },
      setTimeout: (callback, ms) => {
        const timer = {
          callback: () => {
            timer.cleared = true;
            callback();
          },
          ms,
          cleared: false,
        };
        live.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    });
    const pending = () => live.filter((t) => !t.cleared);

    chosenOverlays.value = ['wind'];
    overlayStatus.value = { ...overlayStatus.peek(), wind: windReady(shown, 0) };
    expect(pending().map((t) => t.ms)).toEqual([HOUR]);

    // The step's valid time passes: the proxy still serves it once (nearest is unchanged).
    clock.server = Date.parse(shown) + 1;
    clock.mono = WIND_STEP_RETRY_MS;
    pending()[0]?.callback();
    await flush();
    expect(requested).toEqual([OVERLAY_URLS.wind]);
    expect(overlayStatus.value.wind).toMatchObject({ kind: 'ready', validAt: shown });
    expect(pending().map((t) => t.ms)).toEqual([WIND_STEP_RETRY_MS]);

    // A cadence later the proxy has moved on to the next step, which waits for its own time.
    clock.server += WIND_STEP_RETRY_MS;
    clock.mono += WIND_STEP_RETRY_MS;
    pending()[0]?.callback();
    await flush();
    expect(requested).toHaveLength(2);
    expect(overlayStatus.value.wind).toMatchObject({ kind: 'ready', validAt: later });
    expect(pending().map((t) => t.ms)).toEqual([MAX_CHECK_INTERVAL_MS]);

    chosenOverlays.value = [];
    expect(pending()).toEqual([]);
    stop();
  });
});
