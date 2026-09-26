/**
 * The scenario's one clock, for a test that has to let half an hour pass in a minute.
 *
 * Some claims are about durations no test can wait out: the snapshot-age banner fires
 * past ten minutes (GLOSSARY §3b), and the way back from the static mirror needs thirty
 * minutes of healthy origin answers (ADR-003 A1.2). The world clock is the wall clock
 * plus an offset that only ever grows. Every server in the scenario reads it — the
 * origin's `Date` headers and `generated_at` stamps, the mirror's `Date` and
 * `Last-Modified` — and the page is told the same offset (`InstrumentedPage.setClockOffset`,
 * which shifts `Date.now` and `performance.now`, the two readings the app's clock adapter
 * makes). Moving it is one jump for everybody at once, so the client sees exactly what it
 * would see if the time had really passed: server time and the monotonic clock advanced
 * together, and every stamp it has been handed is that much older.
 *
 * What it deliberately does *not* move is the timers. `setTimeout` keeps real time, so the
 * client keeps polling on its real cadence and every wait in the suite is still a polled
 * condition with a real deadline.
 */

export interface WorldClock {
  /** Epoch ms in scenario time. A bound function: pass it on as a server's clock. */
  readonly now: () => number;
  /** How far scenario time is ahead of the wall clock, in ms. */
  readonly offsetMs: () => number;
  /** Move scenario time forward by `ms` (never back: clocks in this product only advance). */
  readonly advance: (ms: number) => void;
}

export function createWorldClock(): WorldClock {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    offsetMs: () => offset,
    advance: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(`world clock: cannot advance by ${ms} ms`);
      }
      offset += ms;
    },
  };
}
