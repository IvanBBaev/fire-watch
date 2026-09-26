import { describe, expect, it } from 'vitest';

import { isoWeekWindow } from './iso-week.js';
import {
  lifecycleLeadInMs,
  measureFer,
  measureFlr,
  type QaLifecycleHistory,
  type QaTransitionRow,
} from './lifecycle-metrics.js';

const H = 3_600_000;
const W = isoWeekWindow('2026-W38'); // Mon 2026-09-14 00:00Z .. Mon 2026-09-21 00:00Z
const LONG_AGO = W.fromMs - 30 * 24 * H;

function row(
  publicId: string,
  atMs: number,
  from: QaTransitionRow['from'],
  to: QaTransitionRow['to'],
  overrides: Partial<QaTransitionRow> = {},
): QaTransitionRow {
  return {
    publicId,
    atMs,
    from,
    to,
    reason: to === 'no_longer_detected' ? 'miss_evidence' : null,
    maxFrpMw: 10,
    hullAreaHa: 5,
    merged: false,
    reattachedAtMs: null,
    ...overrides,
  };
}

function history(
  transitions: QaTransitionRow[],
  population: QaLifecycleHistory['population'] = [],
  logStartedAtMs: number | null = LONG_AGO,
): QaLifecycleHistory {
  return { logStartedAtMs, transitions, population };
}

describe('lifecycleLeadInMs', () => {
  it('reads the longer of FER’s 72 h and FLR’s 48 h', () => {
    expect(lifecycleLeadInMs()).toBe(72 * H);
  });
});

describe('coverage — an uncovered week is unavailable, never a perfect score', () => {
  it('needs the log from 72 h before the week for FER and 48 h for FLR', () => {
    const started = W.fromMs - 60 * H;
    const h = history([], [], started);
    const ferResult = measureFer(W, h);
    expect(ferResult.status).toBe('unavailable');
    if (ferResult.status === 'unavailable') {
      expect(ferResult.reason).toContain('from 2026-09-11T00:00:00Z');
      expect(ferResult.reason).toContain('began 2026-09-11T12:00:00Z');
    }
    expect(measureFlr(W, h).status).toBe('measured');
  });

  it('counts a log that began exactly at the needed instant as covering it', () => {
    expect(measureFer(W, history([], [], W.fromMs - 72 * H)).status).toBe('measured');
    expect(measureFlr(W, history([], [], W.fromMs - 48 * H)).status).toBe('measured');
  });

  it('is unavailable without an origin row at all', () => {
    expect(measureFer(W, history([], [], null)).status).toBe('unavailable');
    expect(measureFlr(W, history([], [], null)).status).toBe('unavailable');
  });
});

describe('measureFer', () => {
  it('grades declarations in the window shifted back by 72 h, edges half-open', () => {
    const from = W.fromMs - 72 * H;
    const to = W.toMs - 72 * H;
    const result = measureFer(
      W,
      history([
        row('fw-2026-early', from - 1, 'active', 'no_longer_detected'),
        row('fw-2026-first', from, 'active', 'no_longer_detected'),
        row('fw-2026-last', to - 1, 'active', 'no_longer_detected'),
        row('fw-2026-late', to, 'active', 'no_longer_detected'),
      ]),
    );
    if (result.status !== 'measured') throw new Error('expected measured');
    expect(result.declarations).toBe(2);
    expect(result.declarationsFrom).toBe('2026-09-11T00:00:00Z');
    expect(result.declarationsTo).toBe('2026-09-18T00:00:00Z');
  });

  it('counts a re-attachment within 72 h as premature, and one after as a reignition', () => {
    const at = W.fromMs;
    const result = measureFer(
      W,
      history([
        row('fw-2026-back', at, 'active', 'no_longer_detected', { reattachedAtMs: at + 72 * H }),
        row('fw-2026-later', at, 'active', 'no_longer_detected', {
          reattachedAtMs: at + 72 * H + 1,
        }),
        row('fw-2026-quiet', at, 'active', 'no_longer_detected'),
      ]),
    );
    if (result.status !== 'measured') throw new Error('expected measured');
    expect(result.report.falseExtinguishIds).toEqual(['fw-2026-back']);
    expect(result.report.strata[0]?.rate).toMatchObject({ numerator: 1, denominator: 3 });
  });

  it('holds the unobservable fallback out as its own class', () => {
    const result = measureFer(
      W,
      history([
        row('fw-2026-cloud', W.fromMs, 'active', 'no_longer_detected', {
          reason: 'unobservable',
          reattachedAtMs: W.fromMs + H,
        }),
      ]),
    );
    if (result.status !== 'measured') throw new Error('expected measured');
    expect(result.report.excludedUnobservable).toEqual(['fw-2026-cloud']);
    expect(result.report.strata[0]?.rate.denominator).toBe(0);
  });

  it('judges the large class from the facts recorded at the declaration', () => {
    const at = W.fromMs;
    const result = measureFer(
      W,
      history([
        row('fw-2026-wide', at, 'active', 'no_longer_detected', { hullAreaHa: 100 }),
        row('fw-2026-hot', at, 'active', 'no_longer_detected', { maxFrpMw: 100 }),
        row('fw-2026-small', at, 'active', 'no_longer_detected', {
          hullAreaHa: 99.9,
          maxFrpMw: 99.9,
        }),
        row('fw-2026-unknown', at, 'active', 'no_longer_detected', {
          hullAreaHa: null,
          maxFrpMw: null,
        }),
      ]),
    );
    if (result.status !== 'measured') throw new Error('expected measured');
    const byName = Object.fromEntries(result.report.strata.map((s) => [s.name, s.rate]));
    expect(byName['large']?.denominator).toBe(2);
    expect(byName['standard']?.denominator).toBe(2);
  });

  it('gives a second closure of the same event its own id instead of failing the report', () => {
    const at = W.fromMs;
    const result = measureFer(
      W,
      history([
        row('fw-2026-flap', at, 'active', 'no_longer_detected', { reattachedAtMs: at + H }),
        row('fw-2026-flap', at + 2 * H, 'no_longer_detected', 'active'),
        row('fw-2026-flap', at + 30 * H, 'active', 'no_longer_detected'),
      ]),
    );
    if (result.status !== 'measured') throw new Error('expected measured');
    expect(result.declarations).toBe(2);
    expect(result.report.falseExtinguishIds).toEqual(['fw-2026-flap']);
  });

  it('keeps merged-away events: the declaration happened', () => {
    const result = measureFer(
      W,
      history([row('fw-2026-gone', W.fromMs, 'active', 'no_longer_detected', { merged: true })]),
    );
    if (result.status !== 'measured') throw new Error('expected measured');
    expect(result.declarations).toBe(1);
  });
});

describe('measureFlr', () => {
  it('flags three reversals within 48 h, over a denominator that includes silent active events', () => {
    const t = W.fromMs + 10 * H;
    const result = measureFlr(
      W,
      history(
        [
          row('fw-2026-flap', t, 'active', 'signal_weakening'),
          row('fw-2026-flap', t + 4 * H, 'signal_weakening', 'active'),
          row('fw-2026-flap', t + 8 * H, 'active', 'signal_weakening'),
          row('fw-2026-flap', t + 12 * H, 'signal_weakening', 'active'),
        ],
        [
          { publicId: 'fw-2026-flap', statusAtStart: 'active' },
          // Burned all week and never changed: still an active event in the week.
          { publicId: 'fw-2026-steady', statusAtStart: 'active' },
        ],
      ),
    );
    if (result.status !== 'measured') throw new Error('expected measured');
    expect(result.report.flaggedEventIds).toEqual(['fw-2026-flap']);
    expect(result.report.rate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(result.transitionsFrom).toBe('2026-09-12T00:00:00Z');
  });

  it('counts an event born in the week as active, without reading its birth as a reversal', () => {
    const result = measureFlr(
      W,
      history(
        [row('fw-2026-new', W.fromMs + H, null, 'active')],
        [{ publicId: 'fw-2026-new', statusAtStart: null }],
      ),
    );
    if (result.status !== 'measured') throw new Error('expected measured');
    expect(result.report.rate).toMatchObject({ numerator: 0, denominator: 1 });
  });

  it('leaves an event that only weakened out of the active denominator', () => {
    const result = measureFlr(
      W,
      history(
        [row('fw-2026-fading', W.fromMs + H, 'signal_weakening', 'no_longer_detected')],
        [{ publicId: 'fw-2026-fading', statusAtStart: 'signal_weakening' }],
      ),
    );
    if (result.status !== 'measured') throw new Error('expected measured');
    expect(result.report.rate.denominator).toBe(0);
  });

  it('ignores merged-away events', () => {
    const result = measureFlr(
      W,
      history([row('fw-2026-gone', W.fromMs + H, 'active', 'signal_weakening', { merged: true })]),
    );
    if (result.status !== 'measured') throw new Error('expected measured');
    expect(result.report.events).toEqual([]);
  });

  it('refuses a transition whose event the reader left out of the population', () => {
    expect(() =>
      measureFlr(W, history([row('fw-2026-orphan', W.fromMs + H, 'active', 'signal_weakening')])),
    ).toThrow(/no FLR population row/);
  });
});
