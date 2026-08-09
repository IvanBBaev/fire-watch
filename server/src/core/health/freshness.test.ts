import { describe, expect, it } from 'vitest';

import type { FreshnessRowId } from '@fire-watch/contracts';

import {
  FRESHNESS_BUDGETS,
  type FreshnessBudgetTable,
  type FreshnessMute,
} from '../config/freshness-budgets.js';
import { evaluateFreshness, type FreshnessObservation } from './freshness.js';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const MINUTE = 60_000;

/** A source that answered `agoMinutes` ago, with rows, and has not failed since. */
function healthy(row: FreshnessRowId, agoMinutes: number): FreshnessObservation {
  const at = NOW - agoMinutes * MINUTE;
  return { row, lastAttemptAt: at, lastSuccessAt: at, lastDataAt: at, consecutiveFailures: 0 };
}

function muted(mute: Partial<FreshnessMute> = {}): FreshnessBudgetTable {
  return {
    rows: FRESHNESS_BUDGETS.values.rows,
    mutes: [
      {
        row: 'firms:viirs:snpp',
        fromIso: '2026-08-09T06:00:00.000Z',
        untilIso: '2026-08-09T18:00:00.000Z',
        reason: 'NASA announced FIRMS maintenance',
        ...mute,
      },
    ],
  };
}

describe('a healthy deployment', () => {
  it('is 200 and ok when every feed answered inside its budget', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp', 'firms:viirs:noaa20'],
      observations: [healthy('firms:viirs:snpp', 3), healthy('firms:viirs:noaa20', 7)],
    });

    expect(verdict.report.status).toBe('ok');
    expect(verdict.httpStatus).toBe(200);
    expect(verdict.report.rows.map((row) => row.state)).toEqual(['ok', 'ok']);
  });

  it('stays ok through a quiet afternoon with no detections at all', () => {
    // §1.1(5). This is the single most likely false page in the whole system: nine hours of
    // nothing in February is the fire season being over, not the pipeline being broken.
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [
        {
          row: 'firms:viirs:snpp',
          lastAttemptAt: NOW - 4 * MINUTE,
          lastSuccessAt: NOW - 4 * MINUTE,
          lastDataAt: NOW - 9 * 60 * MINUTE,
          consecutiveFailures: 0,
        },
      ],
    });

    expect(verdict.report.status).toBe('ok');
    expect(verdict.report.rows[0]?.lastDataAt).toBe('2026-08-09T03:00:00.000Z');
  });

  it('reports the budget it judged against, so a page carries its own thresholds', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [healthy('firms:viirs:snpp', 1)],
    });

    expect(verdict.report.budgetVersion).toBe('freshness_budgets_v1');
    expect(verdict.report.generatedAt).toBe('2026-08-09T12:00:00.000Z');
    expect(verdict.report.rows[0]).toMatchObject({ warnSeconds: 1200, criticalSeconds: 2700 });
  });
});

describe('a feed going quiet', () => {
  it('warns at the warn budget without failing the probe', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [healthy('firms:viirs:snpp', 21)],
    });

    expect(verdict.report.rows[0]?.state).toBe('warn');
    expect(verdict.report.status).toBe('warn');
    expect(verdict.httpStatus).toBe(200);
  });

  it('warns at exactly the warn budget, because the boundary itself is in the band', () => {
    // The test above overshoots by a minute; this one pins the boundary. `age >= warn` is
    // deliberate — the budget is the last second of health, not the first second of warn —
    // and only an age of exactly 1200 s holds that `>=` in place.
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [healthy('firms:viirs:snpp', 20)],
    });

    expect(verdict.report.rows[0]?.ageSeconds).toBe(1200);
    expect(verdict.report.rows[0]?.state).toBe('warn');
  });

  it('is critical at exactly the critical budget', () => {
    // Same boundary pin as the warn one: at exactly 2700 s the row is already critical,
    // and a paging row past critical is a 500.
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [healthy('firms:viirs:snpp', 45)],
    });

    expect(verdict.report.rows[0]?.ageSeconds).toBe(2700);
    expect(verdict.report.rows[0]?.state).toBe('critical');
    expect(verdict.httpStatus).toBe(500);
  });

  it('is still ok one second before the budget', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [
        { ...healthy('firms:viirs:snpp', 0), lastSuccessAt: NOW - 1_199_000, lastAttemptAt: NOW },
      ],
    });

    expect(verdict.report.rows[0]?.ageSeconds).toBe(1199);
    expect(verdict.report.rows[0]?.state).toBe('ok');
  });

  it('500s once a source that blinds the map is past critical', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp', 'firms:viirs:noaa20'],
      observations: [healthy('firms:viirs:snpp', 46), healthy('firms:viirs:noaa20', 2)],
    });

    expect(verdict.report.status).toBe('critical');
    expect(verdict.httpStatus).toBe(500);
  });

  it('puts the offending row first, because that is the line RB-1 reads', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp', 'firms:viirs:noaa20', 'firms:viirs:noaa21'],
      observations: [
        healthy('firms:viirs:snpp', 2),
        healthy('firms:viirs:noaa20', 25),
        healthy('firms:viirs:noaa21', 90),
      ],
    });

    expect(verdict.report.rows.map((row) => row.row)).toEqual([
      'firms:viirs:noaa21',
      'firms:viirs:noaa20',
      'firms:viirs:snpp',
    ]);
  });

  it('tells the truth in the body about a feed that is not allowed to 500', () => {
    // Weather is a degradation, not an outage (§1.2) — so the body says critical and the
    // wire says 200. Two different questions, deliberately not collapsed into one.
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['weather:context'],
      observations: [healthy('weather:context', 25 * 60)],
    });

    expect(verdict.report.status).toBe('critical');
    expect(verdict.report.rows[0]?.pages).toBe(false);
    expect(verdict.httpStatus).toBe(200);
  });

  it('carries the failure count, so a page can tell a stall from a flap', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [
        { ...healthy('firms:viirs:snpp', 50), lastAttemptAt: NOW, consecutiveFailures: 9 },
      ],
    });

    expect(verdict.report.rows[0]?.consecutiveFailures).toBe(9);
  });
});

describe('a feed nobody has heard from', () => {
  it('is unknown, not ok, when the row has never been touched', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [],
    });

    expect(verdict.report.rows[0]).toMatchObject({
      state: 'unknown',
      ageSeconds: null,
      lastSuccessAt: null,
    });
    expect(verdict.report.status).toBe('warn');
  });

  it('does not 500 a first deploy whose worker has not finished a cycle yet', () => {
    // §2.2(8) rolls a deploy back on a red endpoint. An empty `source_status` on a database
    // created ninety seconds ago must not be that red.
    const verdict = evaluateFreshness({
      now: NOW,
      expected: [...FRESHNESS_BUDGETS.values.rows.map((row) => row.row)],
      observations: [],
    });

    expect(verdict.httpStatus).toBe(200);
    expect(verdict.report.status).toBe('warn');
  });

  it('is critical once it has tried and never once succeeded', () => {
    // A poller that has been asking for an hour and getting nothing has no age to score,
    // and no ambiguity either.
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [
        {
          row: 'firms:viirs:snpp',
          lastAttemptAt: NOW - 30 * MINUTE,
          lastSuccessAt: null,
          lastDataAt: null,
          consecutiveFailures: 6,
        },
      ],
    });

    expect(verdict.report.rows[0]?.state).toBe('critical');
    expect(verdict.httpStatus).toBe(500);
  });

  it('stays unknown when a row exists but records no attempt at all', () => {
    // Defensive pin. The status writer sets the attempt column on every write, so a
    // persisted row with `lastAttemptAt: null` should never occur — but if one ever does,
    // it must read as "never ran", not "never worked": the never-ran side is the one that
    // does not 500 a first deploy (§2.2 rule 8), and the worker-never-started case it
    // would supposedly catch belongs to the heartbeat leg, not this endpoint.
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [
        {
          row: 'firms:viirs:snpp',
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastDataAt: null,
          consecutiveFailures: 0,
        },
      ],
    });

    expect(verdict.report.rows[0]?.state).toBe('unknown');
    expect(verdict.httpStatus).toBe(200);
  });
});

describe('a muted row', () => {
  it('stops paging but stays visible', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [healthy('firms:viirs:snpp', 90)],
      table: muted(),
    });

    expect(verdict.report.rows[0]).toMatchObject({
      state: 'muted',
      mutedUntil: '2026-08-09T18:00:00.000Z',
      muteReason: 'NASA announced FIRMS maintenance',
    });
    expect(verdict.report.status).toBe('warn');
    expect(verdict.httpStatus).toBe(200);
  });

  it('pages again the moment the mute expires, with nobody having to remember', () => {
    const verdict = evaluateFreshness({
      now: Date.parse('2026-08-09T18:00:00.000Z'),
      expected: ['firms:viirs:snpp'],
      observations: [{ ...healthy('firms:viirs:snpp', 0), lastSuccessAt: NOW - 90 * MINUTE }],
      table: muted(),
    });

    expect(verdict.report.rows[0]?.state).toBe('critical');
    expect(verdict.httpStatus).toBe(500);
  });

  it('silences only its own row, never a neighbour that goes critical during the window', () => {
    // The `mute.row === row` clause in `activeMute` is the highest-value line in the mute
    // machinery: without it, a routine maintenance mute on one feed would swallow a
    // critical on ANY other row — no 500, no page — during exactly the window when
    // attention is already somewhere else.
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp', 'firms:viirs:noaa20'],
      observations: [healthy('firms:viirs:snpp', 90), healthy('firms:viirs:noaa20', 90)],
      table: muted(), // mutes firms:viirs:snpp and nothing else
    });

    const bystander = verdict.report.rows.find((row) => row.row === 'firms:viirs:noaa20');
    expect(bystander?.state).toBe('critical');
    expect(verdict.report.rows.find((row) => row.row === 'firms:viirs:snpp')?.state).toBe('muted');
    expect(verdict.httpStatus).toBe(500);
  });

  it('leaves a healthy row alone rather than labelling it muted', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [healthy('firms:viirs:snpp', 2)],
      table: muted(),
    });

    expect(verdict.report.rows[0]).toMatchObject({ state: 'ok', mutedUntil: null });
  });
});

describe('inputs that are not really about freshness', () => {
  it('clamps a timestamp from the future instead of reporting a negative age', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp'],
      observations: [healthy('firms:viirs:snpp', -30)],
    });

    expect(verdict.report.rows[0]?.ageSeconds).toBe(0);
    expect(verdict.report.rows[0]?.state).toBe('ok');
  });

  it('answers once for a row asked about twice', () => {
    const verdict = evaluateFreshness({
      now: NOW,
      expected: ['firms:viirs:snpp', 'firms:viirs:snpp'],
      observations: [healthy('firms:viirs:snpp', 1)],
    });

    expect(verdict.report.rows).toHaveLength(1);
  });

  it('refuses to answer about a row with no budget, because silence would look healthy', () => {
    expect(() =>
      evaluateFreshness({
        now: NOW,
        expected: ['firms:modis' as never],
        observations: [],
      }),
    ).toThrow(/which has no budget/);
  });
});
