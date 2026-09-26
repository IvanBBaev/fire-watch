import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../determinism/canonical-json.js';
import { SHADOW_DIFF } from './shadow-diff-params.js';
import {
  SHADOW_DIFF_KINDS,
  diffKey,
  renderShadowDiffReport,
  shadowDiff,
  type ShadowDiffInput,
  type ShadowSide,
  type ShadowSideAlert,
  type ShadowSideEvent,
} from './shadow-diff.js';
import type { DiffExplanation } from './explanations.js';

const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 7, 20, 0, 0, 0);
const TO = FROM + 24 * HOUR;
const ZONE_A = '0b6f7c1e-0000-4000-8000-00000000000a';
const ZONE_B = '0b6f7c1e-0000-4000-8000-00000000000b';

function event(key: string, uids: readonly string[], overrides: Partial<ShadowSideEvent> = {}) {
  return {
    key,
    status: 'active',
    score: 0.8,
    startedAtMs: FROM + HOUR,
    lastDetectionAtMs: FROM + 2 * HOUR,
    invalidated: false,
    mergedInto: null,
    detectionUids: uids,
    ...overrides,
  } satisfies ShadowSideEvent;
}

function alert(eventKey: string, overrides: Partial<ShadowSideAlert> = {}): ShadowSideAlert {
  return {
    zoneId: ZONE_A,
    eventKey,
    alertType: 'new_fire',
    alertSubkey: 'once',
    templateId: 'new_fire_v1',
    decidedAtMs: FROM + 2 * HOUR,
    ...overrides,
  };
}

function input(
  live: Partial<ShadowSide>,
  shadow: Partial<ShadowSide>,
  explanations: readonly DiffExplanation[] = [],
): ShadowDiffInput {
  return {
    candidateVersion: 'clustering_params_v2',
    window: { fromMs: FROM, toMs: TO },
    live: { events: [], alerts: [], ...live },
    shadow: { events: [], alerts: [], ...shadow },
    explanations,
  };
}

function accepted(key: string): DiffExplanation {
  return { key, disposition: 'accepted', fixtureId: null, reason: 'reviewed' };
}

describe('an identical candidate', () => {
  it('produces no diffs and the all_explained verdict, though it renumbered every event', () => {
    const report = shadowDiff(
      input(
        { events: [event('fw-2026-aaaaa', ['d1', 'd2'])], alerts: [alert('fw-2026-aaaaa')] },
        { events: [event('s-1', ['d2', 'd1'])], alerts: [alert('s-1')] },
      ),
    );
    expect(report.diffs).toEqual([]);
    expect(report.unexplained).toEqual([]);
    expect(report.verdict).toBe('all_explained');
    expect(report.events).toEqual({
      live: 1,
      shadow: 1,
      liveTombstones: 0,
      shadowTombstones: 0,
      paired: 1,
    });
    expect(report.alerts).toEqual({ live: 1, shadow: 1, common: 1, onlyLive: 0, onlyShadow: 0 });
    expect(report.zones).toEqual([
      { zoneId: ZONE_A, liveAlerts: 1, shadowAlerts: 1, onlyLive: 0, onlyShadow: 0, differing: 0 },
    ]);
  });

  it('stamps the config and the window it was produced under', () => {
    const report = shadowDiff(input({}, {}));
    expect(report.configVersion).toBe('shadow_diff_v1');
    expect(report.configDigest).toBe(SHADOW_DIFF.digest);
    expect(report.candidateVersion).toBe('clustering_params_v2');
    expect(report.window).toEqual({
      from: '2026-08-20T00:00:00Z',
      to: '2026-08-21T00:00:00Z',
    });
  });
});

describe('event classification', () => {
  function kindsOf(report: ReturnType<typeof shadowDiff>) {
    return report.diffs.map((d) => d.kind);
  }

  it('calls a shadow event that overlaps nothing created, and a live one dropped', () => {
    const report = shadowDiff(
      input({ events: [event('fw-2026-aaaaa', ['d1'])] }, { events: [event('s-1', ['d9'])] }),
    );
    expect(report.diffs).toEqual([
      {
        key: diffKey('event_created', ['s-1']),
        kind: 'event_created',
        liveEventKey: null,
        shadowEventKey: 's-1',
        zoneId: null,
        detail: { detections: 1, status: 'active' },
        explanation: null,
      },
      {
        key: diffKey('event_dropped', ['fw-2026-aaaaa']),
        kind: 'event_dropped',
        liveEventKey: 'fw-2026-aaaaa',
        shadowEventKey: null,
        zoneId: null,
        detail: { detections: 1, status: 'active' },
        explanation: null,
      },
    ]);
    expect(report.verdict).toBe('unexplained_diffs');
  });

  it('calls a candidate that cuts one live fire in two a split', () => {
    const report = shadowDiff(
      input(
        { events: [event('fw-2026-aaaaa', ['d1', 'd2', 'd3', 'd4'])] },
        { events: [event('s-1', ['d1', 'd2', 'd3']), event('s-2', ['d4'])] },
      ),
    );
    const split = report.diffs.find((d) => d.kind === 'event_split');
    expect(split).toMatchObject({
      shadowEventKey: 's-2',
      detail: { detections: 1, overlapsLive: ['fw-2026-aaaaa'] },
    });
    expect(kindsOf(report).sort()).toEqual(['event_detections_differ', 'event_split']);
  });

  it('calls a candidate that joins two live fires a merge', () => {
    const report = shadowDiff(
      input(
        { events: [event('fw-2026-aaaaa', ['d1', 'd2', 'd3']), event('fw-2026-bbbbb', ['d4'])] },
        { events: [event('s-1', ['d1', 'd2', 'd3', 'd4'])] },
      ),
    );
    expect(report.diffs.find((d) => d.kind === 'event_merged')).toMatchObject({
      liveEventKey: 'fw-2026-bbbbb',
      detail: { detections: 1, overlapsShadow: ['s-1'] },
    });
  });

  it('reports status, bucket, detection and invalidation differences on a paired event', () => {
    const report = shadowDiff(
      input(
        { events: [event('fw-2026-aaaaa', ['d1', 'd2', 'd3'], { score: 0.8 })] },
        {
          events: [
            event('s-1', ['d1', 'd2'], {
              status: 'signal_weakening',
              score: 0.5,
              invalidated: true,
            }),
          ],
        },
      ),
    );
    expect(report.diffs.map((d) => [d.kind, d.detail])).toEqual([
      ['event_detections_differ', { common: 2, onlyLive: 1, onlyShadow: 0 }],
      ['event_invalidated_differs', { live: false, shadow: true }],
      [
        'event_score_bucket_differs',
        { live: 'confirmed', shadow: 'likely', liveScore: 0.8, shadowScore: 0.5 },
      ],
      ['event_status_differs', { live: 'active', shadow: 'signal_weakening' }],
    ]);
    for (const d of report.diffs) {
      expect(d.liveEventKey).toBe('fw-2026-aaaaa');
      expect(d.shadowEventKey).toBe('s-1');
    }
  });

  it('ignores a score wobble inside one bucket', () => {
    const report = shadowDiff(
      input(
        { events: [event('fw-2026-aaaaa', ['d1'], { score: 0.8 })] },
        { events: [event('s-1', ['d1'], { score: 0.9 })] },
      ),
    );
    expect(report.diffs).toEqual([]);
  });

  it('counts merge tombstones but never pairs them', () => {
    const report = shadowDiff(
      input(
        {
          events: [
            event('fw-2026-aaaaa', ['d1', 'd2']),
            event('fw-2026-bbbbb', ['d2'], { mergedInto: 'fw-2026-aaaaa' }),
          ],
        },
        { events: [event('s-1', ['d1', 'd2'])] },
      ),
    );
    expect(report.events).toMatchObject({ live: 1, liveTombstones: 1, paired: 1 });
    expect(report.diffs).toEqual([]);
  });
});

describe('alert classification', () => {
  const pairedEvents = {
    live: [event('fw-2026-aaaaa', ['d1'])],
    shadow: [event('s-1', ['d1'])],
  };

  it('reports an alert only the candidate would have sent, on a paired event', () => {
    const report = shadowDiff(
      input({ events: pairedEvents.live }, { events: pairedEvents.shadow, alerts: [alert('s-1')] }),
    );
    expect(report.diffs).toEqual([
      {
        key: diffKey('alert_only_shadow', [ZONE_A, 'fw-2026-aaaaa', 'new_fire', 'once']),
        kind: 'alert_only_shadow',
        liveEventKey: 'fw-2026-aaaaa',
        shadowEventKey: 's-1',
        zoneId: ZONE_A,
        detail: { decidedAt: '2026-08-20T02:00:00Z', templateId: 'new_fire_v1' },
        explanation: null,
      },
    ]);
    expect(report.alerts).toEqual({ live: 0, shadow: 1, common: 0, onlyLive: 0, onlyShadow: 1 });
  });

  it('keys a shadow alert on an unpaired event by the candidate key', () => {
    const report = shadowDiff(
      input({}, { events: [event('s-9', ['d9'])], alerts: [alert('s-9')] }),
    );
    const line = report.diffs.find((d) => d.kind === 'alert_only_shadow');
    expect(line?.key).toBe(
      diffKey('alert_only_shadow', [ZONE_A, 'shadow:s-9', 'new_fire', 'once']),
    );
    expect(line?.liveEventKey).toBeNull();
  });

  it('reports an alert live decided and the candidate would not have', () => {
    const report = shadowDiff(
      input(
        { events: pairedEvents.live, alerts: [alert('fw-2026-aaaaa')] },
        { events: pairedEvents.shadow },
      ),
    );
    expect(report.diffs.map((d) => d.kind)).toEqual(['alert_only_live']);
    expect(report.zones).toEqual([
      { zoneId: ZONE_A, liveAlerts: 1, shadowAlerts: 0, onlyLive: 1, onlyShadow: 0, differing: 0 },
    ]);
  });

  it('reports a template and a timing difference on the same alert, once per zone', () => {
    const report = shadowDiff(
      input(
        { events: pairedEvents.live, alerts: [alert('fw-2026-aaaaa')] },
        {
          events: pairedEvents.shadow,
          alerts: [alert('s-1', { templateId: 'new_fire_v2', decidedAtMs: FROM + 3 * HOUR })],
        },
      ),
    );
    expect(report.diffs.map((d) => [d.kind, d.detail])).toEqual([
      [
        'alert_decided_at_differs',
        { live: '2026-08-20T02:00:00Z', shadow: '2026-08-20T03:00:00Z', deltaMs: HOUR },
      ],
      ['alert_template_differs', { live: 'new_fire_v1', shadow: 'new_fire_v2' }],
    ]);
    expect(report.zones[0]).toMatchObject({ differing: 1 });
  });

  it('shows any timing shift while the tolerance is unset, and honours one when set', () => {
    const shifted = input(
      { events: pairedEvents.live, alerts: [alert('fw-2026-aaaaa')] },
      { events: pairedEvents.shadow, alerts: [alert('s-1', { decidedAtMs: FROM + 2 * HOUR + 1 })] },
    );
    expect(SHADOW_DIFF.values.alerts.decidedAtToleranceMs).toBeNull();
    expect(shadowDiff(shifted).diffs.map((d) => d.kind)).toEqual(['alert_decided_at_differs']);

    const tolerant = { ...SHADOW_DIFF.values, alerts: { decidedAtToleranceMs: 1 } };
    expect(shadowDiff(shifted, tolerant).diffs).toEqual([]);
  });

  it('keeps zones apart and lists them in id order', () => {
    const report = shadowDiff(
      input(
        {
          events: pairedEvents.live,
          alerts: [alert('fw-2026-aaaaa', { zoneId: ZONE_B }), alert('fw-2026-aaaaa')],
        },
        { events: pairedEvents.shadow, alerts: [alert('s-1', { zoneId: ZONE_B })] },
      ),
    );
    expect(report.zones.map((z) => [z.zoneId, z.onlyLive])).toEqual([
      [ZONE_A, 1],
      [ZONE_B, 0],
    ]);
  });

  it('refuses two alerts under one idempotency key', () => {
    expect(() =>
      shadowDiff(input({ alerts: [alert('fw-2026-aaaaa'), alert('fw-2026-aaaaa')] }, {})),
    ).toThrow(/idempotency key/);
  });
});

describe('explanations — GATES L-1 "every diff explained"', () => {
  const created = diffKey('event_created', ['s-1']);
  const dropped = diffKey('event_dropped', ['fw-2026-aaaaa']);
  const base = (explanations: readonly DiffExplanation[]) =>
    input(
      { events: [event('fw-2026-aaaaa', ['d1'])] },
      { events: [event('s-1', ['d9'])] },
      explanations,
    );

  it('attaches an explanation to its diff and leaves the rest unexplained', () => {
    const report = shadowDiff(
      base([{ key: created, disposition: 'fixture', fixtureId: 'S19', reason: 'new detector' }]),
    );
    expect(report.diffs.find((d) => d.key === created)?.explanation).toEqual({
      disposition: 'fixture',
      fixtureId: 'S19',
      reason: 'new detector',
    });
    expect(report.unexplained).toEqual([dropped]);
    expect(report.verdict).toBe('unexplained_diffs');
  });

  it('turns the verdict only when every diff is explained', () => {
    const report = shadowDiff(base([accepted(created), accepted(dropped)]));
    expect(report.unexplained).toEqual([]);
    expect(report.verdict).toBe('all_explained');
  });

  it('reports an explanation whose diff has gone away as stale, without counting it', () => {
    const gone = diffKey('event_created', ['s-404']);
    const report = shadowDiff(base([accepted(created), accepted(dropped), accepted(gone)]));
    expect(report.staleExplanations).toEqual([gone]);
    expect(report.verdict).toBe('all_explained');
  });

  it('refuses two explanations of one diff', () => {
    expect(() => shadowDiff(base([accepted(created), accepted(created)]))).toThrow(/same diff/);
  });
});

describe('countsByKind', () => {
  it('lists every kind, zero included', () => {
    const report = shadowDiff(input({}, {}));
    expect(Object.keys(report.countsByKind).sort()).toEqual([...SHADOW_DIFF_KINDS].sort());
    expect(Object.values(report.countsByKind).every((n) => n === 0)).toBe(true);
  });
});

describe('projected DAR', () => {
  it('runs core/qa/dar.ts on each side, resolving merges to the survivor', () => {
    // Live notified the zone about a parent, then again about the survivor of a merge 1 h
    // later: one fire, two new-fire alerts — a duplicate. The candidate sent one.
    const report = shadowDiff(
      input(
        {
          events: [
            event('fw-2026-aaaaa', ['d1', 'd2']),
            event('fw-2026-bbbbb', ['d2'], { mergedInto: 'fw-2026-aaaaa' }),
          ],
          alerts: [
            alert('fw-2026-bbbbb'),
            alert('fw-2026-aaaaa', { decidedAtMs: FROM + 3 * HOUR }),
          ],
        },
        { events: [event('s-1', ['d1', 'd2'])], alerts: [alert('s-1')] },
      ),
    );
    expect(report.projectedDar.live.rate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(report.projectedDar.shadow.rate).toMatchObject({ numerator: 0, denominator: 1 });
  });

  it('reads the escalation rung back from the step-N subkey', () => {
    const report = shadowDiff(
      input(
        {
          events: [event('fw-2026-aaaaa', ['d1'])],
          alerts: [
            alert('fw-2026-aaaaa', { alertType: 'escalation', alertSubkey: 'step-1' }),
            alert('fw-2026-aaaaa', {
              alertType: 'escalation',
              alertSubkey: 'step-2',
              decidedAtMs: FROM + 3 * HOUR,
            }),
          ],
        },
        {},
      ),
    );
    // A higher rung inside the window is not a duplicate.
    expect(report.projectedDar.live.rate.numerator).toBe(0);
  });

  it('refuses an escalation whose subkey is not a rung', () => {
    expect(() =>
      shadowDiff(
        input({ alerts: [alert('e', { alertType: 'escalation', alertSubkey: 'once' })] }, {}),
      ),
    ).toThrow(/step-N/);
  });
});

describe('input validation', () => {
  it.each([
    ['an empty window', { window: { fromMs: FROM, toMs: FROM } }, /end after/],
    ['a non-finite window', { window: { fromMs: FROM, toMs: Number.NaN } }, /finite/],
    [
      'an unknown status',
      { live: { events: [event('e', ['d'], { status: 'burning' as never })], alerts: [] } },
      /status/,
    ],
    [
      'a score outside [0, 1]',
      { live: { events: [event('e', ['d'], { score: 1.5 })], alerts: [] } },
      /score/,
    ],
    [
      'an unknown alert type',
      { live: { events: [], alerts: [alert('e', { alertType: 'all_clear' as never })] } },
      /vocabulary/,
    ],
  ])('refuses %s', (_label, overrides, message) => {
    expect(() => shadowDiff({ ...input({}, {}), ...overrides })).toThrow(message);
  });

  it('refuses a negative tolerance', () => {
    const params = { ...SHADOW_DIFF.values, alerts: { decidedAtToleranceMs: -1 } };
    expect(() => shadowDiff(input({}, {}), params)).toThrow(/decidedAtToleranceMs/);
  });
});

describe('determinism — the report is bytes a reviewer signs', () => {
  const busy = input(
    {
      events: [
        event('fw-2026-aaaaa', ['d1', 'd2', 'd3', 'd4']),
        event('fw-2026-bbbbb', ['d5', 'd6']),
        event('fw-2026-ccccc', ['d7']),
        event('fw-2026-ddddd', ['d8'], { mergedInto: 'fw-2026-bbbbb' }),
      ],
      alerts: [
        alert('fw-2026-aaaaa'),
        alert('fw-2026-bbbbb', { zoneId: ZONE_B }),
        alert('fw-2026-ccccc', { alertType: 'digest', alertSubkey: '2026-08-20T00:00:00.000Z' }),
      ],
    },
    {
      events: [
        event('s-1', ['d1', 'd2', 'd3'], { status: 'signal_weakening' }),
        event('s-2', ['d4']),
        event('s-3', ['d5', 'd6', 'd8'], { score: 0.3 }),
        event('s-4', ['d42']),
      ],
      alerts: [
        alert('s-1', { templateId: 'new_fire_v2' }),
        alert('s-4', { zoneId: ZONE_B }),
        alert('s-3', { alertType: 'escalation', alertSubkey: 'step-1' }),
      ],
    },
    [accepted(diffKey('event_created', ['s-4'])), accepted('event_created:["gone"]')],
  );

  it('renders byte-identical output on a double run', () => {
    const first = renderShadowDiffReport(shadowDiff(busy));
    const second = renderShadowDiffReport(shadowDiff(busy));
    expect(second).toBe(first);
    expect(first).toBe(canonicalJson(JSON.parse(first)));
  });

  it('exercises most kinds at once, so the double run is not over an empty report', () => {
    expect(shadowDiff(busy).countsByKind).toEqual({
      event_created: 1,
      event_dropped: 1,
      event_split: 1,
      event_merged: 0,
      event_status_differs: 1,
      event_score_bucket_differs: 1,
      event_detections_differ: 2,
      event_invalidated_differs: 0,
      alert_only_shadow: 2,
      alert_only_live: 2,
      alert_template_differs: 1,
      alert_decided_at_differs: 0,
    });
  });

  it('renders the same bytes for any input order', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer(),
        fc.integer(),
        fc.integer(),
        fc.integer(),
        (a, b, c, d, e) => {
          const shuffled: ShadowDiffInput = {
            ...busy,
            live: {
              events: shuffle(busy.live.events, a).map((ev) => ({
                ...ev,
                detectionUids: shuffle(ev.detectionUids, b),
              })),
              alerts: shuffle(busy.live.alerts, c),
            },
            shadow: {
              events: shuffle(busy.shadow.events, d),
              alerts: shuffle(busy.shadow.alerts, e),
            },
            explanations: shuffle(busy.explanations, a ^ e),
          };
          expect(renderShadowDiffReport(shadowDiff(shuffled))).toBe(
            renderShadowDiffReport(shadowDiff(busy)),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

/** A seeded Fisher–Yates; the seed comes from fast-check so a failure shrinks and replays. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
