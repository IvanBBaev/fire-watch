import { describe, expect, it } from 'vitest';

import { LIFECYCLE_PARAMS } from '../config/lifecycle-params.js';
import { fer, type ExtinguishDeclaration, type FerStratumName } from './fer.js';
import { QA_METRICS } from './qa-metrics-params.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 7, 20, 6, 0, 0);
const WINDOW_MS = LIFECYCLE_PARAMS.values.ferWindowHours * HOUR;

function declaration(overrides: Partial<ExtinguishDeclaration> = {}): ExtinguishDeclaration {
  return {
    publicId: 'e1',
    declaredAtMs: T0,
    reason: 'miss_evidence',
    large: false,
    reattachedAtMs: null,
    ...overrides,
  };
}

function stratum(report: ReturnType<typeof fer>, name: FerStratumName) {
  const found = report.strata.find((entry) => entry.name === name);
  expect(found).toBeDefined();
  return found;
}

describe('the 72 h window', () => {
  it('reads its length from lifecycle_params_v1 rather than restating 72', () => {
    expect(fer({ declarations: [] }).windowHours).toBe(LIFECYCLE_PARAMS.values.ferWindowHours);
    expect(LIFECYCLE_PARAMS.values.ferWindowHours).toBe(72);
  });

  it('counts a re-attachment inside the window as a false extinguish', () => {
    const report = fer({
      declarations: [declaration({ reattachedAtMs: T0 + 12 * HOUR })],
    });
    expect(report.falseExtinguishIds).toEqual(['e1']);
    expect(stratum(report, 'overall')?.rate.numerator).toBe(1);
  });

  it('counts a re-attachment at exactly 72 h — the window is closed', () => {
    const report = fer({ declarations: [declaration({ reattachedAtMs: T0 + WINDOW_MS })] });
    expect(report.falseExtinguishIds).toEqual(['e1']);
  });

  it('calls a re-attachment one millisecond later a reignition, not a false extinguish', () => {
    const report = fer({ declarations: [declaration({ reattachedAtMs: T0 + WINDOW_MS + 1 })] });
    expect(report.falseExtinguishIds).toEqual([]);
    expect(stratum(report, 'overall')?.rate.numerator).toBe(0);
    // Still in the denominator: the event did enter no_longer_detected in the window.
    expect(stratum(report, 'overall')?.rate.denominator).toBe(1);
  });

  it('leaves an event that never came back in the denominator only', () => {
    const report = fer({ declarations: [declaration()] });
    expect(stratum(report, 'overall')?.rate).toMatchObject({ numerator: 0, denominator: 1 });
  });
});

describe('the large-event stratum', () => {
  const declarations = [
    declaration({ publicId: 'big-1', large: true, reattachedAtMs: T0 + HOUR }),
    declaration({ publicId: 'big-2', large: true }),
    declaration({ publicId: 'big-3', large: true }),
    declaration({ publicId: 'big-4', large: true }),
    declaration({ publicId: 'big-5', large: true }),
    declaration({ publicId: 'big-6', large: true }),
    declaration({ publicId: 'big-7', large: true }),
    declaration({ publicId: 'big-8', large: true }),
    declaration({ publicId: 'big-9', large: true }),
    declaration({ publicId: 'big-10', large: true }),
  ];

  it('grades it against the looser large threshold', () => {
    const report = fer({ declarations });
    const large = stratum(report, 'large');
    expect(large?.rate.rate).toBe(0.1);
    expect(large?.maxRate).toBe(LIFECYCLE_PARAMS.values.ferMaxRateLarge);
    expect(large?.meetsTarget).toBe(true);
    // The same 10 % fails the overall 5 % — which is the point of having two thresholds.
    expect(stratum(report, 'overall')?.meetsTarget).toBe(false);
  });

  it('reports the non-large class without a threshold, because no document states one', () => {
    const report = fer({ declarations: [declaration({ publicId: 'small', reattachedAtMs: T0 })] });
    const standard = stratum(report, 'standard');
    expect(standard?.rate.rate).toBe(1);
    expect(standard?.maxRate).toBeNull();
    expect(standard?.meetsTarget).toBeNull();
  });

  it('splits the population so large and standard partition the overall one', () => {
    const report = fer({
      declarations: [
        declaration({ publicId: 'a', large: true }),
        declaration({ publicId: 'b', large: false }),
        declaration({ publicId: 'c', large: false }),
      ],
    });
    expect(stratum(report, 'overall')?.rate.denominator).toBe(3);
    expect(stratum(report, 'large')?.rate.denominator).toBe(1);
    expect(stratum(report, 'standard')?.rate.denominator).toBe(2);
  });
});

describe('the 5 % threshold', () => {
  const twenty = (falseCount: number): ExtinguishDeclaration[] =>
    Array.from({ length: 20 }, (_unused, index) =>
      declaration({
        publicId: `e${String(index)}`,
        reattachedAtMs: index < falseCount ? T0 + HOUR : null,
      }),
    );

  it('passes a rate sitting exactly on it', () => {
    expect(stratum(fer({ declarations: twenty(1) }), 'overall')?.rate.rate).toBe(0.05);
    expect(stratum(fer({ declarations: twenty(1) }), 'overall')?.meetsTarget).toBe(true);
  });

  it('fails one event past it', () => {
    expect(stratum(fer({ declarations: twenty(2) }), 'overall')?.meetsTarget).toBe(false);
  });
});

describe('the ≥ 14-day unobservable closure (A2.3(3))', () => {
  it('holds it out of the whole population, not just the numerator', () => {
    const report = fer({
      declarations: [
        declaration({ publicId: 'seen', reattachedAtMs: T0 + HOUR }),
        declaration({ publicId: 'blind', reason: 'unobservable' }),
      ],
    });
    // Numerator-only exclusion would give 1/2 = 50 %; excluding the class gives 1/1.
    expect(stratum(report, 'overall')?.rate).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it('names every excluded event, so the class cannot absorb a miss silently', () => {
    const report = fer({
      declarations: [
        declaration({ publicId: 'blind-1', reason: 'unobservable' }),
        declaration({ publicId: 'blind-2', reason: 'unobservable', reattachedAtMs: T0 + HOUR }),
      ],
    });
    expect(report.excludedUnobservable).toEqual(['blind-1', 'blind-2']);
    expect(report.falseExtinguishIds).toEqual([]);
    expect(stratum(report, 'overall')?.rate.denominator).toBe(0);
  });

  it('is a config switch, so the literal A2.3(3) reading is one version bump away', () => {
    const literal = { ...QA_METRICS.values, fer: { excludeUnobservableClosures: false } };
    const report = fer(
      {
        declarations: [
          declaration({ publicId: 'seen', reattachedAtMs: T0 + HOUR }),
          declaration({ publicId: 'blind', reason: 'unobservable' }),
        ],
      },
      literal,
    );
    expect(stratum(report, 'overall')?.rate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(report.excludedUnobservable).toEqual([]);
  });
});

describe('an empty window', () => {
  it('reports every stratum as absent, never as a clean 0 %', () => {
    const report = fer({ declarations: [] });
    for (const entry of report.strata) {
      expect(entry.rate.denominator).toBe(0);
      expect(entry.rate.rate).toBeNull();
      expect(entry.meetsTarget).toBeNull();
    }
  });
});

describe('corrupt input', () => {
  it('refuses a re-attachment before the declaration it is measured from', () => {
    expect(() => fer({ declarations: [declaration({ reattachedAtMs: T0 - 1 })] })).toThrow(
      /re-attaches before/,
    );
  });

  it('refuses the same event twice in one window', () => {
    expect(() => fer({ declarations: [declaration(), declaration()] })).toThrow(/appears twice/);
  });

  it('refuses a non-finite instant', () => {
    expect(() => fer({ declarations: [declaration({ declaredAtMs: Number.NaN })] })).toThrow(
      /non-finite/,
    );
  });
});

describe('the report as an evidence artifact', () => {
  it('names the lifecycle params version whose weights this rate is the objective for', () => {
    const report = fer({ declarations: [] });
    expect(report.lifecycleParamsVersion).toBe(LIFECYCLE_PARAMS.version);
    expect(report.configVersion).toBe(QA_METRICS.version);
    expect(report.configDigest).toBe(QA_METRICS.digest);
  });
});
