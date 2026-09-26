import { describe, expect, it } from 'vitest';

import { flr, type FlrInput, type LifecycleTransition } from './flr.js';
import { QA_METRICS } from './qa-metrics-params.js';

const HOUR = 3_600_000;
const WINDOW_START = Date.UTC(2026, 7, 17, 0, 0, 0);
const WINDOW_END = Date.UTC(2026, 7, 24, 0, 0, 0);
const T = (hoursAfterStart: number): number => WINDOW_START + hoursAfterStart * HOUR;

/** `active → weakening → active → weakening …`, one step every `stepHours`. */
function flapping(
  publicId: string,
  from: number,
  steps: number,
  stepHours: number,
): LifecycleTransition[] {
  return Array.from({ length: steps }, (_unused, index) => ({
    publicId,
    atMs: from + index * stepHours * HOUR,
    from: index % 2 === 0 ? ('active' as const) : ('signal_weakening' as const),
    to: index % 2 === 0 ? ('signal_weakening' as const) : ('active' as const),
  }));
}

function input(overrides: Partial<FlrInput> = {}): FlrInput {
  return {
    windowStartMs: WINDOW_START,
    windowEndMs: WINDOW_END,
    events: [{ publicId: 'e1', activeInWindow: true }],
    transitions: [],
    ...overrides,
  };
}

describe('counting reversals', () => {
  it('reads its parameters from qa_metrics_v1: 3 reversals within 48 h', () => {
    const report = flr(input());
    expect(report.minReversals).toBe(3);
    expect(report.windowHours).toBe(48);
  });

  it('counts a change of direction, not a transition', () => {
    // active → weakening → active → weakening: the first step sets a direction, the next
    // two oppose the one before them. Two reversals from four states, not three.
    const report = flr(input({ transitions: flapping('e1', T(1), 3, 4) }));
    expect(report.events[0]?.reversals).toBe(2);
    expect(report.events[0]?.flagged).toBe(false);
  });

  it('flags at exactly three reversals inside 48 h', () => {
    const report = flr(input({ transitions: flapping('e1', T(1), 4, 4) }));
    expect(report.events[0]?.reversals).toBe(3);
    expect(report.events[0]?.flagged).toBe(true);
    expect(report.flaggedEventIds).toEqual(['e1']);
  });

  it('does not flag a monotone decline, however many steps it takes', () => {
    const transitions: LifecycleTransition[] = [
      { publicId: 'e1', atMs: T(1), from: 'active', to: 'signal_weakening' },
      { publicId: 'e1', atMs: T(2), from: 'signal_weakening', to: 'no_longer_detected' },
      { publicId: 'e1', atMs: T(3), from: 'no_longer_detected', to: 'archived' },
    ];
    const report = flr(input({ transitions }));
    expect(report.events[0]?.reversals).toBe(0);
  });

  it('ranks `archived` at zero rather than treating it as no rank at all', () => {
    // no_longer_detected → archived is a fall (rank 1 → 0), so a following rise reverses it.
    const transitions: LifecycleTransition[] = [
      { publicId: 'e1', atMs: T(1), from: 'no_longer_detected', to: 'archived' },
      { publicId: 'e1', atMs: T(2), from: 'archived', to: 'active' },
    ];
    expect(flr(input({ transitions })).events[0]?.reversals).toBe(1);
  });

  it('records the instant of each reversal as the evidence behind the flag', () => {
    const report = flr(input({ transitions: flapping('e1', T(1), 4, 4) }));
    expect(report.events[0]?.reversalAtMs).toEqual([T(5), T(9), T(13)]);
  });
});

describe('the 48 h burst window', () => {
  it('flags three reversals spanning exactly 48 h', () => {
    // Reversals at +1 h, +25 h, +49 h → the first and third are 48 h apart.
    const transitions = flapping('e1', T(1), 4, 24);
    const report = flr(input({ transitions }));
    expect(report.events[0]?.reversalAtMs).toEqual([T(25), T(49), T(73)]);
    expect(report.events[0]?.flagged).toBe(true);
  });

  it('does not flag three reversals spread over more than 48 h', () => {
    const transitions = flapping('e1', T(1), 4, 25);
    const report = flr(input({ transitions }));
    expect(report.events[0]?.reversals).toBe(3);
    expect(report.events[0]?.flagged).toBe(false);
  });

  it('slides: a burst anywhere in a long history flags the event', () => {
    const slow = flapping('e1', T(1), 3, 40);
    const fast = flapping('e1', T(130), 4, 2).map((transition, index) => ({
      ...transition,
      // Continue the alternation from where the slow run left off.
      from: index % 2 === 0 ? ('signal_weakening' as const) : ('active' as const),
      to: index % 2 === 0 ? ('active' as const) : ('signal_weakening' as const),
    }));
    const report = flr(input({ transitions: [...slow, ...fast] }));
    expect(report.events[0]?.flagged).toBe(true);
  });

  it('uses the lead-in to start a burst but requires it to end inside the window', () => {
    const leadIn = flapping('e1', WINDOW_START - 40 * HOUR, 4, 4);
    const report = flr(input({ transitions: leadIn }));
    expect(report.events[0]?.reversals).toBe(3);
    // Every reversal predates the window; last month's flapping is not this week's number.
    expect(report.events[0]?.flagged).toBe(false);
  });

  it('flags a burst that began in the lead-in and completed inside the window', () => {
    const straddling = flapping('e1', WINDOW_START - 20 * HOUR, 4, 8);
    const report = flr(input({ transitions: straddling }));
    expect(report.events[0]?.flagged).toBe(true);
  });
});

describe('curated statements', () => {
  it('treats an official declaration as neutral and breaks the chain on it', () => {
    // A run of three reversals interrupted by a curated statement no longer has three
    // consecutive ones — the authority speaking is not the detector flapping.
    const transitions: LifecycleTransition[] = [
      ...flapping('e1', T(1), 2, 2),
      { publicId: 'e1', atMs: T(6), from: 'active', to: 'officially_contained' },
      { publicId: 'e1', atMs: T(8), from: 'officially_contained', to: 'active' },
      ...flapping('e1', T(10), 2, 2),
    ];
    const report = flr(input({ transitions }));
    expect(report.events[0]?.reversals).toBe(2);
    expect(report.events[0]?.flagged).toBe(false);
  });

  it('does not count the curated transition itself as a direction', () => {
    const transitions: LifecycleTransition[] = [
      { publicId: 'e1', atMs: T(1), from: 'active', to: 'officially_extinguished' },
      { publicId: 'e1', atMs: T(2), from: 'officially_extinguished', to: 'active' },
    ];
    expect(flr(input({ transitions })).events[0]?.reversals).toBe(0);
  });
});

describe('the denominator', () => {
  it('is active events, not every event with a history', () => {
    const report = flr(
      input({
        events: [
          { publicId: 'e1', activeInWindow: true },
          { publicId: 'e2', activeInWindow: false },
        ],
        transitions: [...flapping('e1', T(1), 4, 4), ...flapping('e2', T(1), 4, 4)],
      }),
    );
    expect(report.rate).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it('still reports a flagged inactive event, which is worth a review it cannot be counted in', () => {
    const report = flr(
      input({
        events: [{ publicId: 'e2', activeInWindow: false }],
        transitions: flapping('e2', T(1), 4, 4),
      }),
    );
    expect(report.flaggedInactiveEventIds).toEqual(['e2']);
    expect(report.flaggedEventIds).toEqual([]);
    expect(report.rate.rate).toBeNull();
  });

  it('reports an empty population as absent, never as 0 % flapping', () => {
    const report = flr(input({ events: [], transitions: [] }));
    expect(report.rate.denominator).toBe(0);
    expect(report.rate.rate).toBeNull();
  });
});

describe('FLR carries no numeric gate', () => {
  it('reports a null target, because GLOSSARY §8 sets none', () => {
    const report = flr(input({ transitions: flapping('e1', T(1), 6, 2) }));
    expect(report.rate.rate).toBe(1);
    expect(report.target).toBeNull();
  });
});

describe('corrupt input', () => {
  it('refuses a transition for an event outside the population', () => {
    expect(() =>
      flr(
        input({ transitions: [{ publicId: 'ghost', atMs: T(1), from: 'active', to: 'archived' }] }),
      ),
    ).toThrow(/unknown event/);
  });

  it('refuses a transition outside the window plus its lead-in', () => {
    expect(() =>
      flr(
        input({
          transitions: [{ publicId: 'e1', atMs: WINDOW_END + 1, from: 'active', to: 'archived' }],
        }),
      ),
    ).toThrow(/outside the window/);
    expect(() =>
      flr(
        input({
          transitions: [
            { publicId: 'e1', atMs: WINDOW_START - 49 * HOUR, from: 'active', to: 'archived' },
          ],
        }),
      ),
    ).toThrow(/outside the window/);
  });

  it('refuses a window that ends before it starts', () => {
    expect(() => flr(input({ windowStartMs: WINDOW_END, windowEndMs: WINDOW_START }))).toThrow(
      /ends before it starts/,
    );
  });

  it('refuses a duplicate event', () => {
    expect(() =>
      flr(
        input({
          events: [
            { publicId: 'e1', activeInWindow: true },
            { publicId: 'e1', activeInWindow: false },
          ],
        }),
      ),
    ).toThrow(/duplicate/);
  });
});

describe('the report as an evidence artifact', () => {
  it('carries the config identity', () => {
    const report = flr(input());
    expect(report.configVersion).toBe(QA_METRICS.version);
    expect(report.configDigest).toBe(QA_METRICS.digest);
  });
});
