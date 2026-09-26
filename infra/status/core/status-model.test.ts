import { describe, expect, it } from 'vitest';

import { SNAPSHOT_PUSH_WARN_SECONDS } from '../../../packages/contracts/src/freshness.js';

import { parseFreshnessBody, type FreshnessBody } from './freshness-body.js';
import {
  COMPONENT_IDS,
  SNAPSHOT_AGE_BUDGET,
  STATUS_SCHEMA,
  evaluateApi,
  evaluateFreshness,
  evaluateMirror,
  evaluateSnapshot,
  evaluateStatus,
  overallLevel,
  parsePreviousModel,
  type BodyObservation,
  type ComponentId,
  type ComponentLevel,
  type ComponentStatus,
  type HeadObservation,
  type ProbeResults,
  type ReasonCode,
  type StatusModel,
} from './status-model.js';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

const snapshot = (generatedAt: unknown, status = 200): BodyObservation => ({
  kind: 'response',
  status,
  body: { generated_at: generatedAt, detections: [] },
});

const head = (
  generatedAtHeader: string | null,
  lastModifiedHeader: string | null = null,
  status = 200,
): HeadObservation => ({ kind: 'response', status, generatedAtHeader, lastModifiedHeader });

const report = (status: 'ok' | 'warn' | 'critical', httpStatus = 200): BodyObservation => ({
  kind: 'response',
  status: httpStatus,
  body: {
    status,
    generatedAt: ago(0),
    budgetVersion: 'v1',
    rows: [
      {
        row: 'firms:viirs:snpp',
        state: status,
        pages: true,
        ageSeconds: 60,
        lastSuccessAt: ago(60),
        mutedUntil: null,
        muteReason: null,
      },
      {
        row: 'lsasaf:seviri:frp-pixel',
        state: 'muted',
        pages: true,
        ageSeconds: 7200,
        lastSuccessAt: ago(7200),
        mutedUntil: '2026-09-26T00:00:00Z',
        muteReason: 'Provider maintenance',
      },
    ],
  },
});

const healthy: ProbeResults = {
  healthz: { kind: 'response', status: 200 },
  freshness: report('ok'),
  snapshot: snapshot(ago(30)),
  mirror: head(ago(90)),
};

const parsedOf = (observation: BodyObservation): FreshnessBody | null =>
  observation.kind === 'response' ? parseFreshnessBody(observation.body) : null;

const run = (
  results: ProbeResults,
  previous: StatusModel | null = null,
  nowMs = NOW,
): StatusModel =>
  evaluateStatus({ results, parsedFreshness: parsedOf(results.freshness), nowMs, previous });

const component = (model: StatusModel, id: ComponentId): ComponentStatus => {
  const found = model.components.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no component ${id}`);
  return found;
};

const comp = (
  id: ComponentId,
  level: ComponentLevel,
  reason: ReasonCode = level === 'operational' ? 'up' : 'unreachable',
): ComponentStatus => ({
  id,
  level,
  reason,
  ageSeconds: null,
  dataGeneratedAt: null,
  since: ago(0),
  unconfirmed: false,
});

describe('budget', () => {
  it('warns exactly where the contract snapshot-push promise breaks (drift pin)', () => {
    expect(SNAPSHOT_AGE_BUDGET.warnSeconds).toBe(SNAPSHOT_PUSH_WARN_SECONDS);
    expect(SNAPSHOT_AGE_BUDGET.criticalSeconds).toBe(15 * 60);
  });
});

describe('evaluateApi', () => {
  it('maps liveness to up / outage', () => {
    expect(evaluateApi({ kind: 'response', status: 204 })).toMatchObject({
      level: 'operational',
      reason: 'up',
    });
    expect(evaluateApi({ kind: 'response', status: 503 })).toMatchObject({
      level: 'outage',
      reason: 'http_status',
    });
    expect(evaluateApi({ kind: 'unreachable' })).toMatchObject({
      level: 'outage',
      reason: 'unreachable',
    });
    expect(evaluateApi({ kind: 'not_configured' })).toMatchObject({
      level: 'unknown',
      reason: 'not_configured',
    });
  });
});

describe('evaluateSnapshot', () => {
  it.each([
    [0, 'operational', 'fresh'],
    [299, 'operational', 'fresh'],
    [300, 'degraded', 'stale'],
    [899, 'degraded', 'stale'],
    [900, 'outage', 'stale'],
  ] as const)('bands an age of %i s as %s', (age, level, reason) => {
    expect(evaluateSnapshot(snapshot(ago(age)), NOW)).toMatchObject({
      level,
      reason,
      ageSeconds: age,
      dataGeneratedAt: ago(age),
    });
  });

  it('tolerates a small future skew, flags a large one', () => {
    expect(evaluateSnapshot(snapshot(ago(-30)), NOW)).toMatchObject({
      level: 'operational',
      ageSeconds: 0,
    });
    expect(evaluateSnapshot(snapshot(ago(-120)), NOW)).toMatchObject({
      level: 'degraded',
      reason: 'future_stamp',
    });
  });

  it('refuses to age a body without a readable generated_at', () => {
    expect(evaluateSnapshot(snapshot(undefined), NOW).reason).toBe('bad_body');
    expect(evaluateSnapshot(snapshot('yesterday'), NOW).reason).toBe('bad_body');
    expect(evaluateSnapshot({ kind: 'response', status: 200, body: '<html>' }, NOW).reason).toBe(
      'bad_body',
    );
  });

  it('treats a non-2xx as an outage', () => {
    expect(evaluateSnapshot(snapshot(ago(0), 502), NOW)).toMatchObject({
      level: 'outage',
      reason: 'http_status',
    });
  });
});

describe('evaluateMirror', () => {
  it('prefers the job-written header over Last-Modified', () => {
    const lastModified = new Date(NOW - 20 * 60 * 1000).toUTCString();
    expect(evaluateMirror(head(ago(60), lastModified), NOW)).toMatchObject({
      level: 'operational',
      ageSeconds: 60,
    });
  });

  it('falls back to Last-Modified, then gives up', () => {
    const lastModified = new Date(NOW - 20 * 60 * 1000).toUTCString();
    expect(evaluateMirror(head(null, lastModified), NOW)).toMatchObject({
      level: 'outage',
      reason: 'stale',
      ageSeconds: 1200,
    });
    expect(evaluateMirror(head('garbage', lastModified), NOW).ageSeconds).toBe(1200);
    expect(evaluateMirror(head(null, null), NOW)).toMatchObject({
      level: 'outage',
      reason: 'no_age_signal',
    });
  });

  it.each([403, 404, 410])('reads %i as a missing object', (status) => {
    expect(evaluateMirror(head(null, null, status), NOW).reason).toBe('missing');
  });

  it('reads other errors as http_status', () => {
    expect(evaluateMirror(head(null, null, 500), NOW).reason).toBe('http_status');
  });
});

describe('evaluateFreshness', () => {
  const judge = (o: BodyObservation) => evaluateFreshness(o, parsedOf(o));

  it('maps report status and wire status', () => {
    expect(judge(report('ok'))).toMatchObject({ level: 'operational', reason: 'report_ok' });
    expect(judge(report('warn'))).toMatchObject({ level: 'degraded', reason: 'report_warn' });
    // A 200 "critical" is a non-paging row past budget: degraded, not an outage.
    expect(judge(report('critical'))).toMatchObject({
      level: 'degraded',
      reason: 'report_critical',
    });
    expect(judge(report('critical', 500))).toMatchObject({
      level: 'outage',
      reason: 'report_critical',
    });
  });

  it('separates an announced endpoint failure from an unreadable body', () => {
    expect(judge({ kind: 'response', status: 500, body: { error: 'db timeout' } })).toMatchObject({
      level: 'outage',
      reason: 'endpoint_error',
    });
    expect(judge({ kind: 'response', status: 200, body: 'nope' })).toMatchObject({
      level: 'unknown',
      reason: 'bad_body',
    });
  });

  it('leaves an unreachable origin to the api component', () => {
    expect(judge({ kind: 'unreachable' })).toMatchObject({
      level: 'unknown',
      reason: 'unreachable',
    });
  });
});

describe('overallLevel', () => {
  const all = (levels: Partial<Record<ComponentId, ComponentLevel>>): ComponentStatus[] =>
    COMPONENT_IDS.map((id) => comp(id, levels[id] ?? 'operational'));

  it('is operational when everything is', () => {
    expect(overallLevel(all({}))).toBe('operational');
  });

  it('caps a backup outage at degraded', () => {
    expect(overallLevel(all({ 'map-backup': 'outage' }))).toBe('degraded');
  });

  it('reads a primary map outage with a healthy backup as degraded', () => {
    expect(overallLevel(all({ map: 'outage' }))).toBe('degraded');
  });

  it('is an outage when both map legs are down, or the api is', () => {
    expect(overallLevel(all({ map: 'outage', 'map-backup': 'outage' }))).toBe('outage');
    expect(overallLevel(all({ map: 'outage', 'map-backup': 'degraded' }))).toBe('outage');
    expect(overallLevel(all({ api: 'outage' }))).toBe('outage');
  });

  it('leaves unconfigured components out, and is unknown when nothing is configured', () => {
    const partial = [
      comp('api', 'operational'),
      comp('map', 'unknown', 'not_configured'),
      comp('map-backup', 'unknown', 'not_configured'),
      comp('data-freshness', 'operational', 'report_ok'),
    ];
    expect(overallLevel(partial)).toBe('operational');
    expect(overallLevel(COMPONENT_IDS.map((id) => comp(id, 'unknown', 'not_configured')))).toBe(
      'unknown',
    );
  });

  it('ranks unknown above operational', () => {
    expect(overallLevel(all({ 'data-freshness': 'unknown' }))).toBe('unknown');
  });
});

describe('evaluateStatus', () => {
  it('builds the full model for a healthy service', () => {
    const model = run(healthy);
    expect(model.schema).toBe(STATUS_SCHEMA);
    expect(model.generatedAt).toBe('2026-09-25T12:00:00.000Z');
    expect(model.overall).toBe('operational');
    expect(model.components.map((c) => c.id)).toEqual([...COMPONENT_IDS]);
    expect(model.components.every((c) => c.since === model.generatedAt)).toBe(true);
    expect(model.budgetVersion).toBe('v1');
    expect(model.sources).toEqual([
      {
        row: 'firms:viirs:snpp',
        level: 'on_time',
        ageSeconds: 60,
        lastSuccessAt: ago(60),
        mutedUntil: null,
        muteReason: null,
      },
      {
        row: 'lsasaf:seviri:frp-pixel',
        level: 'muted',
        ageSeconds: 7200,
        lastSuccessAt: ago(7200),
        mutedUntil: '2026-09-26T00:00:00Z',
        muteReason: 'Provider maintenance',
      },
    ]);
  });

  it('never carries a URL, host name or error text into the model', () => {
    const model = run({
      ...healthy,
      healthz: { kind: 'unreachable' },
      snapshot: { kind: 'response', status: 500, body: 'upstream api.internal.example failed' },
    });
    const json = JSON.stringify(model);
    expect(json).not.toMatch(/https?:|internal|example|failed/);
  });

  it('publishes a first outage as unconfirmed degraded, then confirms it (§2.2 rule 7)', () => {
    const down: ProbeResults = { ...healthy, healthz: { kind: 'unreachable' } };
    const first = run(down, run(healthy, null, NOW - 900_000));
    expect(component(first, 'api')).toMatchObject({
      level: 'degraded',
      unconfirmed: true,
      since: first.generatedAt,
    });
    const second = run(down, first, NOW + 900_000);
    expect(component(second, 'api')).toMatchObject({
      level: 'outage',
      unconfirmed: false,
      // The incident started when it was first seen.
      since: first.generatedAt,
    });
    const third = run(down, second, NOW + 1_800_000);
    expect(component(third, 'api').since).toBe(first.generatedAt);
  });

  it('does not wait for confirmation when the component was already failing', () => {
    const slow = run({ ...healthy, snapshot: snapshot(ago(400)) });
    expect(component(slow, 'map')).toMatchObject({ level: 'degraded', unconfirmed: false });
    const dead = run({ ...healthy, snapshot: snapshot(ago(1000)) }, slow, NOW + 60_000);
    expect(component(dead, 'map')).toMatchObject({ level: 'outage', unconfirmed: false });
    expect(component(dead, 'map').since).not.toBe(slow.generatedAt);
  });

  it('resets since on recovery', () => {
    const down = run({ ...healthy, healthz: { kind: 'unreachable' } });
    const up = run(healthy, down, NOW + 900_000);
    expect(component(up, 'api')).toMatchObject({
      level: 'operational',
      since: up.generatedAt,
    });
  });

  it('publishes no sources when the report cannot be read', () => {
    const model = run({ ...healthy, freshness: { kind: 'unreachable' } });
    expect(model.sources).toEqual([]);
    expect(model.budgetVersion).toBeNull();
  });
});

describe('parsePreviousModel', () => {
  it('round-trips what evaluateStatus published', () => {
    const model = run({ ...healthy, healthz: { kind: 'unreachable' } });
    const parsed = parsePreviousModel(JSON.parse(JSON.stringify(model)) as unknown);
    expect(parsed?.components.map((c) => [c.id, c.level, c.since, c.unconfirmed])).toEqual(
      model.components.map((c) => [c.id, c.level, c.since, c.unconfirmed]),
    );
  });

  it.each([
    ['null', null],
    ['another schema', { schema: 'other/1', components: [] }],
    [
      'an unknown level',
      { schema: STATUS_SCHEMA, components: [{ id: 'api', level: 'on-fire', since: ago(0) }] },
    ],
    [
      'an unreadable since',
      { schema: STATUS_SCHEMA, components: [{ id: 'api', level: 'outage', since: 'then' }] },
    ],
  ])('rejects %s', (_label, value) => {
    expect(parsePreviousModel(value)).toBeNull();
  });
});
